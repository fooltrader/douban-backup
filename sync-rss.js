const {config} = require('dotenv');
const {Client} = require("@notionhq/client");
const dayjs = require('dayjs');
const got = require('got');
const jsdom = require("jsdom");
const {JSDOM} = jsdom;
const Parser = require('rss-parser');
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Cookie': process.env.DOUBAN_COOKIE,
  }
});
const {DB_PROPERTIES, PropertyType, sleep} = require('./util');

config();

const RATING_TEXT = {
  '很差': 1,
  '较差': 2,
  '还行': 3,
  '推荐': 4,
  '力荐': 5,
};
const done = /^(看过|听过|读过|玩过)/;
const CATEGORY = {
  movie: 'movie',
  music: 'music',
  book: 'book',
  game: 'game',
  drama: 'drama',
};
const EMOJI = {
  movie: '🎞',
  music: '🎶',
  book: '📖',
  game: '🕹',
  drama: '💃🏻',
};

const DOUBAN_USER_ID = process.env.DOUBAN_USER_ID;
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});
const movieDBID = process.env.NOTION_MOVIE_DATABASE_ID;
const musicDBID = process.env.NOTION_MUSIC_DATABASE_ID;
const bookDBID = process.env.NOTION_BOOK_DATABASE_ID;
const gameDBID = process.env.NOTION_GAME_DATABASE_ID;
const dramaDBID = process.env.NOTION_DRAMA_DATABASE_ID;

(async () => {
  console.log('Refreshing feeds from RSS...');
  let feed;
  try {
    feed = await parser.parseURL(`https://www.douban.com/feed/people/${DOUBAN_USER_ID}/interests`);
  } catch (error) {
    console.error('Failed to parse RSS url: ', error);
    process.exit(1);
  }

  let feedData = {};

  feed = feed.items.filter(item => done.test(item.title));
  feed.forEach(item => {
    const {category, id} = getCategoryAndId(item.title, item.link);
    const dom = new JSDOM(item.content.trim());
    const contents = [...dom.window.document.querySelectorAll('td p')];
    let rating = contents.filter(el => el.textContent.startsWith('推荐'));
    if (rating.length) {
      rating = rating[0].textContent.replace(/^推荐: /, '').trim();
      rating = RATING_TEXT[rating];
    }
    let comment = contents.filter(el => el.textContent.startsWith('备注'));
    if (comment.length) {
      comment = comment[0].textContent.replace(/^备注: /, '').trim();
    }
    let tag = contents.filter(el => el.textContent.startsWith('标签'));
    if (tag.length) {
      tag = tag[0].textContent.replace(/^标签: /, '').trim().split(' ');
    }
    const result = {
      id,
      link: item.link,
      rating: typeof rating === 'number' ? rating : null,
      comment: typeof comment === 'string' ? comment : null,
      time: item.isoDate,
      tag: tag,
    };
    if (!feedData[category]) {
      feedData[category] = [];
    }
    feedData[category].push(result);
  });

  if (feed.length === 0) {
    console.log('No new items.');
    return;
  }

  const categoryKeys = Object.keys(feedData);
  if (categoryKeys.length) {
    for (const cateKey of categoryKeys) {
      try {
        await handleFeed(feedData[cateKey], cateKey);
      } catch (error) {
        console.error(`Failed to handle ${cateKey} feed. `, error);
      }
    }
  }

  console.log('All feeds are handled.');
})();

async function handleFeed(feed, category) {
  if (feed.length === 0) {
    console.log(`No new ${category} feeds.`);
    return;
  }
  const dbID = getDBID(category);
  if (!dbID) {
    console.log(`No notion database id for ${category}`);
    return;
  }

  console.log(`Handling ${category} feeds...`);
  let filtered;
  try {
    filtered = await notion.databases.query({
      database_id: dbID,
      filter: {
        or: feed.map(item => ({
          property: DB_PROPERTIES.ITEM_LINK,
          url: {
            contains: item.id,
          },
        })),
      },
    });
  } catch (error) {
    console.error(`Failed to query ${category} database to check already inserted items. `, error);
    return;
  }

  if (filtered.results.length) {
    feed = feed.filter(item => {
      let findItem = filtered.results.filter(i => i.properties[DB_PROPERTIES.ITEM_LINK].url === item.link);
      return !findItem.length;
    });
  }

  console.log(`There are total ${feed.length} new ${category} item(s) need to insert.`);

  for (let i = 0; i < feed.length; i++) {
    const item = feed[i];
    const link = item.link;
    let itemData;
    try {
      itemData = await fetchItem(link, category);
      itemData[DB_PROPERTIES.ITEM_LINK] = link;
      itemData[DB_PROPERTIES.RATING] = item.rating;
      itemData[DB_PROPERTIES.RATING_DATE] = dayjs(item.time).format('YYYY-MM-DD');
      itemData[DB_PROPERTIES.COMMENTS] = item.comment;
      itemData[DB_PROPERTIES.TAG] = item.tag;
    } catch (error) {
      console.error(link, error);
    }

    if (itemData) {
      await addToNotion(itemData, category);
      await sleep(1000);
    }
  }
  console.log(`${category} feeds done.`);
  console.log('====================');
}

function getCategoryAndId(title, link) {
  let m = title.match(done);
  m = m[1];
  let res, id;
  switch (m) {
    case '看过':
      if (link.startsWith('https://movie.douban.com/')) {
        res = CATEGORY.movie;
        id = link.match(/movie\.douban\.com\/subject\/(\d+)\/?/);
        id = id[1];
      } else {
        res = CATEGORY.drama;
        id = link.match(/www\.douban\.com\/location\/drama\/(\d+)\/?/);
        id = id[1];
      }
      break;
    case '读过':
      res = CATEGORY.book;
      id = link.match(/book\.douban\.com\/subject\/(\d+)\/?/);
      id = id[1];
      break;
    case '听过':
      res = CATEGORY.music;
      id = link.match(/music\.douban\.com\/subject\/(\d+)\/?/);
      id = id[1];
      break;
    case '玩过':
      res = CATEGORY.game;
      id = link.match(/www\.douban\.com\/game\/(\d+)\/?/);
      id = id[1];
      break;
    default:
      break;
  }
  return {category: res, id};
}

function getDBID(category) {
  let id;
  switch (category) {
    case CATEGORY.movie:
      id = movieDBID;
      break;
    case CATEGORY.music:
      id = musicDBID;
      break;
    case CATEGORY.book:
      id = bookDBID;
      break;
    case CATEGORY.game:
      id = gameDBID;
      break;
    case CATEGORY.drama:
      id = dramaDBID;
      break;
    default:
      break;
  }
  return id;
}

async function fetchItem(link, category) {
  console.log(`Fetching ${category} item with link: ${link}`);
  const itemData = {};
  const response = await got(link, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': process.env.DOUBAN_COOKIE,
    }
  });
  const dom = new JSDOM(response.body);

  if (category === CATEGORY.movie) {
    itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#content h1 [property="v:itemreviewed"]').textContent.trim();
    itemData[DB_PROPERTIES.YEAR] = dom.window.document.querySelector('#content h1 .year').textContent.slice(1, -1);
    itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('#mainpic img')?.src.replace(/\.webp$/, '.jpg');
    itemData[DB_PROPERTIES.DIRECTORS] = dom.window.document.querySelector('#info .attrs')?.textContent;
    itemData[DB_PROPERTIES.ACTORS] = [...dom.window.document.querySelectorAll('#info .actor .attrs a')].slice(0, 5).map(i => i.textContent).join(' / ');
    itemData[DB_PROPERTIES.GENRE] = [...dom.window.document.querySelectorAll('#info [property="v:genre"]')].map(i => i.textContent);
    const imdbInfo = [...dom.window.document.querySelectorAll('#info span.pl')].filter(i => i.textContent.startsWith('IMDb'));
    if (imdbInfo.length) {
      itemData[DB_PROPERTIES.IMDB_LINK] = 'https://www.imdb.com/title/' + imdbInfo[0].nextSibling.textContent.trim();
    }

  } else if (category === CATEGORY.music) {
    itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#wrapper h1 span').textContent.trim();
    itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('#mainpic img')?.src.replace(/\.webp$/, '.jpg');
    let info = [...dom.window.document.querySelectorAll('#info span.pl')];
    let release = info.filter(i => i.textContent.trim().startsWith('发行时间'));
    if (release.length) {
      let date = release[0].nextSibling.textContent.trim();
      itemData[DB_PROPERTIES.RELEASE_DATE] = dayjs(date).format('YYYY-MM-DD');
    }
    let musician = info.filter(i => i.textContent.trim().startsWith('表演者'));
    if (musician.length) {
      itemData[DB_PROPERTIES.MUSICIAN] = musician[0].textContent.replace('表演者:', '').trim().split('\n').map(v => v.trim()).join('');
    }

  } else if (category === CATEGORY.book) {
    itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#wrapper h1 [property="v:itemreviewed"]').textContent.trim();
    itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('#mainpic img')?.src.replace(/\.webp$/, '.jpg');
    let info = [...dom.window.document.querySelectorAll('#info span.pl')];
    info.forEach(i => {
      let text = i.textContent.trim();
      let nextText = i.nextSibling?.textContent.trim();
      if (text.startsWith('作者')) {
        let parent = i.parentElement;
        if (parent.id === 'info') {
          itemData[DB_PROPERTIES.WRITER] = i.nextElementSibling.textContent.replace(/\n/g, '').replace(/\s/g, '');
        } else {
          itemData[DB_PROPERTIES.WRITER] = i.parentElement.textContent.trim().replace('作者:', '').trim();
        }
      } else if (text.startsWith('出版社')) {
        itemData[DB_PROPERTIES.PUBLISHING_HOUSE] = nextText;
      } else if (text.startsWith('原作名')) {
        itemData[DB_PROPERTIES.TITLE] += nextText;
      } else if (text.startsWith('出版年')) {
        itemData[DB_PROPERTIES.PUBLICATION_DATE] = dayjs(nextText).format('YYYY-MM-DD');
      } else if (text.startsWith('ISBN')) {
        itemData[DB_PROPERTIES.ISBN] = Number(nextText);
      }
    });

  } else if (category === CATEGORY.game) {
    itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#wrapper #content h1').textContent.trim();
    itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('.item-subject-info .pic img')?.src.replace(/\.webp$/, '.jpg');
    const gameInfo = dom.window.document.querySelector('#content .thing-attr');
    const dts = [...gameInfo.querySelectorAll('dt')].filter(i => i.textContent.startsWith('类型') || i.textContent.startsWith('发行日期'));
    if (dts.length) {
      dts.forEach(dt => {
        if (dt.textContent.startsWith('类型')) {
          itemData[DB_PROPERTIES.GENRE] = [...dt.nextElementSibling.querySelectorAll('a')].map(a => a.textContent.trim());
        } else if (dt.textContent.startsWith('发行日期')) {
          let date = dt.nextElementSibling.textContent.trim();
          itemData[DB_PROPERTIES.RELEASE_DATE] = dayjs(date).format('YYYY-MM-DD');
        }
      })
    }

  } else if (category === CATEGORY.drama) {
    itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#content .drama-info .meta h1').textContent.trim();
    let genre = dom.window.document.querySelector('#content .drama-info .meta [itemprop="genre"]').textContent.trim();
    itemData[DB_PROPERTIES.GENRE] = [genre];
    itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('.drama-info .pic img')?.src.replace(/\.webp$/, '.jpg');
  }

  return itemData;
}

function getPropertyValye(value, type, key) {
  let res = null;
  switch (type) {
    case 'title':
      res = {
        title: [{ text: { content: value } }],
      };
      break;
    case 'file':
      res = {
        files: [{ name: value, external: { url: value } }],
      };
      break;
    case 'date':
      res = { date: { start: value } };
      break;
    case 'select':  // 新增：处理单选类型
      res = {
        select: value ? { name: value } : null,
      };
      break;
    case 'multi_select':
      res = key === DB_PROPERTIES.RATING ? {
        'multi_select': value ? [{ name: value.toString() }] : [],
      } : {
        'multi_select': (value || []).map(g => ({ name: g })),
      };
      break;
    case 'rich_text':
      res = {
        'rich_text': [{ type: 'text', text: { content: value || '' } }],
      };
      break;
    case 'number':
      res = { number: value ? Number(value) : null };
      break;
    case 'url':
      res = { url: value || null };
      break;
    default:
      break;
  }
  return res;
}

async function addToNotion(itemData, category) {
  console.log('Going to insert ', itemData[DB_PROPERTIES.RATING_DATE], itemData[DB_PROPERTIES.TITLE]);
  try {
    let properties = {};
    const keys = Object.keys(DB_PROPERTIES);
    keys.forEach(key => {
      if (itemData[DB_PROPERTIES[key]]) {
        properties[DB_PROPERTIES[key]] = getPropertyValye(itemData[DB_PROPERTIES[key]], PropertyType[key], DB_PROPERTIES[key]);
      }
    });

    const dbid = getDBID(category);
    if (!dbid) {
      throw new Error('No database id found for category: ' + category);
    }
    const db = await notion.databases.retrieve({database_id: dbid});
    const columns = Object.keys(db.properties);
    const propKeys = Object.keys(properties);
    propKeys.map(prop => {
      if (prop != DB_PROPERTIES.POSTER && columns.indexOf(prop) < 0) {
        delete properties[prop];
      }
    });

    const postData = {
      parent: { database_id: dbid },
      icon: { type: 'emoji', emoji: EMOJI[category] },
      properties,
    };

    if (properties[DB_PROPERTIES.POSTER]) {
      postData.children = [
        {
          object: 'block',
          type: 'image',
          image: {
            type: 'external',
            external: {
              url: properties[DB_PROPERTIES.POSTER]?.files[0]?.external?.url,
            },
          }
        }
      ];
      delete properties[DB_PROPERTIES.POSTER];
    }
    const response = await notion.pages.create(postData);
    if (response && response.id) {
      console.log(itemData[DB_PROPERTIES.TITLE] + `[${itemData[DB_PROPERTIES.ITEM_LINK]}]` + ' page created.');
    }
  } catch (error) {
    console.warn('Failed to create ' + itemData[DB_PROPERTIES.TITLE] + `(${itemData[DB_PROPERTIES.ITEM_LINK]})` + ' with error: ', error);
  }
}
