// propertyfinder_office_scraper.cjs

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const { parse } = require('json2csv');
const { execSync } = require('child_process');

// Apply the stealth plugin
puppeteer.use(StealthPlugin());

// Function to find Chrome executable
function findChrome() {
    const possiblePaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ];
    
    // Try to find Chrome using which command
    try {
        const chromePath = execSync('which google-chrome').toString().trim();
        if (chromePath) return chromePath;
    } catch (e) {
        console.log('Chrome not found using which command');
    }
    
    // Check possible paths
    for (const path of possiblePaths) {
        try {
            if (fs.existsSync(path)) {
                console.log('Found Chrome at:', path);
                return path;
            }
        } catch (e) {
            console.log('Error checking path:', path, e);
        }
    }
    
    throw new Error('Could not find Chrome installation');
}

// ---------- Helper Functions ----------

/**
 * Convert a relative time string (e.g., "8 hours ago") to an absolute Date.
 * @param {string} relativeStr - The relative time string.
 * @param {Date} baseDate - The reference time (usually the scrape time).
 * @returns {Date|null} The absolute date, or null if parsing fails.
 */
function parseRelativeTime(relativeStr, baseDate = new Date()) {
  if (!relativeStr) return null;
  const lower = relativeStr.toLowerCase();
  const regex = /(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/;
  const match = lower.match(regex);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const date = new Date(baseDate);
    switch (unit) {
      case 'minute': date.setMinutes(date.getMinutes() - value); break;
      case 'hour':   date.setHours(date.getHours() - value); break;
      case 'day':    date.setDate(date.getDate() - value); break;
      case 'week':   date.setDate(date.getDate() - (value * 7)); break;
      case 'month':  date.setMonth(date.getMonth() - value); break;
      case 'year':   date.setFullYear(date.getFullYear() - value); break;
      default: return null;
    }
    return date;
  }
  return null;
}

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_4_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:102.0) Gecko/20100101 Firefox/102.0'
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// ---------- Configuration ----------
const START_URL = 'https://www.propertyfinder.ae/en/search?l=1&c=3&t=4&fu=0&af=1500&ob=nd';
const MIN_AREA_SQFT = 1500;
const CUTOFF_DATE = new Date();
CUTOFF_DATE.setMonth(CUTOFF_DATE.getMonth() - 2); // Set to 2 months ago

// ---------- Global Results Array ----------
const results = [];

// ---------- Main Function ----------
async function run() {
    const chromePath = '/usr/bin/chromium';
    console.log('Using Chrome path:', chromePath);
    
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(getRandomUserAgent());
        
        // Process overview pages
        let currentUrl = START_URL;
        let hasNextPage = true;
        let currentPage = 1;

        while (hasNextPage) {
            console.log(`Processing page ${currentPage}: ${currentUrl}`);
            await page.goto(currentUrl, { waitUntil: 'networkidle0' });
            await page.waitForTimeout(2000);

            // Extract listings
            const listings = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('article, div.ListingCard, div.card')).map(el => {
                    const title = el.querySelector('h2')?.innerText.trim() || null;
                    const location = el.querySelector('[class*="location"]')?.innerText.trim() || null;
                    const price = el.querySelector('[class*="price"]')?.innerText.trim() || null;
                    let area = null;
                    const allTexts = Array.from(el.querySelectorAll('*')).map(e => e.innerText || '');
                    for (const txt of allTexts) {
                        const match = txt.replace(/,/g, '').match(/(\d+)\s*sqft/i);
                        if (match) {
                            area = parseInt(match[1], 10);
                            break;
                        }
                    }
                    const description = el.querySelector('[class*="description"]')?.innerText.trim() || null;
                    const listed = el.querySelector('[class*="listed"]')?.innerText.trim() || null;
                    const url = el.querySelector('a')?.href || null;
                    return { title, location, price, area, description, listed, url };
                });
            });

            // Process valid listings
            for (const item of listings) {
                if (!item.area || item.area < MIN_AREA_SQFT) continue;
                
                if (item.url) {
                    // Process detail page
                    const detailPage = await browser.newPage();
                    await detailPage.setUserAgent(getRandomUserAgent());
                    await detailPage.goto(item.url, { waitUntil: 'networkidle0' });
                    await detailPage.waitForTimeout(2000);

                    const details = await detailPage.evaluate(() => {
                        const description = document.querySelector('#description article')?.innerText.trim() || null;
                        const listed = document.querySelector('main div p:nth-child(4)')?.innerText.trim() || null;
                        return { description, listed };
                    });

                    item.description = details.description;
                    item.listed = details.listed;
                    
                    if (item.listed) {
                        const cleanString = item.listed.replace(/listed\s*/i, '').trim();
                        const parsedDate = parseRelativeTime(cleanString, new Date());
                        if (parsedDate) {
                            item.absoluteListedDate = parsedDate.toISOString();
                        }
                    }

                    await detailPage.close();
                    await page.waitForTimeout(1000 + Math.random() * 1000);
                }

                results.push(item);
            }

            // Check for next page
            const nextUrl = await page.evaluate(() => {
                const nextButton = document.querySelector('a[aria-label*="Next"]');
                return nextButton ? nextButton.href : null;
            });

            if (nextUrl) {
                currentUrl = nextUrl;
                currentPage++;
                await page.waitForTimeout(2000 + Math.random() * 1000);
            } else {
                hasNextPage = false;
            }
        }

        // Filter and sort results
        const filteredResults = results.filter(item => {
            if (!item.absoluteListedDate) return true;
            const listedDate = new Date(item.absoluteListedDate);
            return listedDate >= CUTOFF_DATE;
        });

        const sortedResults = filteredResults.sort((a, b) => {
            if (!a.absoluteListedDate) return 1;
            if (!b.absoluteListedDate) return -1;
            return new Date(b.absoluteListedDate) - new Date(a.absoluteListedDate);
        });

        // Save results
        const csv = parse(sortedResults);
        fs.writeFileSync('results.csv', csv);
        console.log(`Scraping completed. Found ${sortedResults.length} listings.`);

    } catch (error) {
        console.error('Error during scraping:', error);
    } finally {
        await browser.close();
    }
}

// ---------- Run the Scraper ----------
run().catch(console.error);
