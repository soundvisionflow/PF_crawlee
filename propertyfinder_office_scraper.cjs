// propertyfinder_office_scraper.cjs

const { PlaywrightCrawler } = require('crawlee');
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const { parse } = require('json2csv');

// Apply the stealth plugin to help avoid detection.
chromium.use(stealthPlugin());

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
const CUTOFF_DATE = new Date("2025-01-01");

// ---------- Global Results Array ----------
const results = [];

// ---------- Crawler Setup ----------
const crawler = new PlaywrightCrawler({
  launchContext: {
    launcher: chromium,
    launchOptions: { headless: true }
  },
  maxConcurrency: 1, // Sequential processing to ensure proper pagination and detail extraction.
  preNavigationHooks: [
    async ({ page }) => {
      const ua = getRandomUserAgent();
      await page.setExtraHTTPHeaders({ 'User-Agent': ua });
      // Random delay to mimic human behavior.
      await page.waitForTimeout(1000 + Math.random() * 1000);
    }
  ],
  requestHandler: async ({ page, request, log }) => {
    // ---- DETAIL PAGE PROCESSING ----
    if (request.userData && request.userData.label === 'DETAIL') {
      log.info(`Processing DETAIL page: ${request.url}`);
      // Wait for description container.
      await page.waitForSelector('#description', { timeout: 10000 }).catch(() => {
        log.error(`Timeout waiting for #description on ${request.url}`);
      });
      
      // Click "See full description" button if it exists using provided XPath.
      try {
        const seeFullButton = page.locator('xpath=//*[@id="description"]/div/button/span');
        if (await seeFullButton.count() > 0) {
          await seeFullButton.first().click();
          await page.waitForTimeout(1000);
        }
      } catch (err) {
        log.error(`Error clicking "See full description" on ${request.url}: ${err.message}`);
      }
      
      let description = null;
      let listed = null;
      
      try {
        const descLocator = page.locator('xpath=//*[@id="description"]/div/article');
        if (await descLocator.count() > 0) {
          description = (await descLocator.first().innerText()).trim();
        } else {
          log.info(`No description element on ${request.url}`);
        }
      } catch (err) {
        log.error(`Error extracting description on ${request.url}: ${err.message}`);
      }
      
      try {
        const listedLocator = page.locator('xpath=//*[@id="root_element"]/main/div[1]/div[1]/div[4]/div[1]/p[4]');
        if (await listedLocator.count() > 0) {
          listed = (await listedLocator.first().innerText()).trim();
        } else {
          log.info(`No listed element on ${request.url}`);
        }
      } catch (err) {
        log.error(`Error extracting listed on ${request.url}: ${err.message}`);
      }
      
      // Convert relative "listed" string to an absolute date.
      let absoluteListedDate = null;
      if (listed) {
        const cleanString = listed.replace(/listed\s*/i, '').trim();
        const parsedDate = parseRelativeTime(cleanString, new Date());
        if (parsedDate) {
          absoluteListedDate = parsedDate.toISOString();
        }
      }
      
      // Update the matching overview entry.
      const idx = results.findIndex(item => item.url === request.url);
      if (idx >= 0) {
        results[idx].description = description;
        results[idx].listed = listed;
        results[idx].absoluteListedDate = absoluteListedDate;
      } else {
        log.info(`No matching overview entry for detail ${request.url}`);
      }
      
      log.info(`Detail processed for ${request.url}: description length=${description ? description.length : 0}, listed=${listed}, absoluteListedDate=${absoluteListedDate}`);
      return;
    }
    
    // ---- OVERVIEW PAGE PROCESSING ----
    // Wait for the page content and sorting options to load
    await page.waitForSelector('article, div.ListingCard, div.card', { timeout: 15000 });
    
    // Ensure we're on a page with newest sorting parameter
    if (!page.url().includes('ob=nd')) {
        const currentUrl = new URL(page.url());
        currentUrl.searchParams.set('ob', 'nd'); // nd = newest date
        log.info(`Redirecting to URL with newest sorting: ${currentUrl.toString()}`);
        await page.goto(currentUrl.toString(), { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
    }

    // Verify sorting is applied
    const sortIndicator = await page.$('[data-testid="dropdown-button"], button:has-text("Sort by")');
    if (sortIndicator) {
        const sortText = await sortIndicator.textContent();
        if (!sortText.toLowerCase().includes('newest')) {
            log.info('Attempting to apply manual sort');
            try {
                await sortIndicator.click();
                await page.waitForTimeout(1000);
                
                const newestOption = await page.waitForSelector('text="Newest"', { timeout: 5000 });
                if (newestOption) {
                    await newestOption.click();
                    await page.waitForTimeout(3000);
                }
            } catch (err) {
                log.error(`Failed to apply manual sort: ${err.message}`);
            }
        }
    }
    
    let hasNextPage = true;
    let currentPage = 1;
    while (hasNextPage) {
      log.info(`Processing OVERVIEW Page ${currentPage}: ${page.url()}`);
      
      // Extract listings using flexible selectors.
      const listings = await page.$$eval(
        'article, div.ListingCard, div.card',
        (elements) => {
          return Array.from(elements).map(el => {
            // You can customize selectors here if needed.
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
            // Overview pages may contain partial information.
            const description = el.querySelector('[class*="description"]')?.innerText.trim() || null;
            const listed = el.querySelector('[class*="listed"]')?.innerText.trim() || null;
            const dateText = el.querySelector('[class*="date"]')?.innerText.trim() || null;
            const url = el.querySelector('a')?.href || null;
            return { title, location, price, area, description, listed, dateText, url };
          });
        }
      );
      
      console.log('RAW listings:', listings);
      
      for (const item of listings) {
        if (!item.area || item.area < MIN_AREA_SQFT) continue;
        results.push(item);
        console.log('Valid Listing:', item);
        if (item.url) {
          await crawler.addRequests([{ url: item.url, userData: { label: 'DETAIL' } }]);
        }
      }
      
      // Pagination: look for the "Next" button.
      const nextButton = await page.$('a[aria-label="Next"]') || await page.$('a.pagination__next');
      if (nextButton) {
        const nextUrl = await nextButton.getAttribute('href');
        if (nextUrl) {
          const fullUrl = nextUrl.startsWith('http') ? nextUrl : 'https://www.propertyfinder.ae' + nextUrl;
          log.info(`Navigating to Next Overview Page: ${fullUrl}`);
          await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
          currentPage++;
          await page.waitForTimeout(1500 + Math.random() * 1000);
          continue;
        }
      }
      hasNextPage = false;
    }
  },
  failedRequestHandler: ({ request, log }) => {
    log.error(`❌ Failed to process ${request.url}`);
  }
});

// ---------- Main Execution ----------
(async () => {
  await crawler.run([START_URL]);
  
  // ----- Filter Listings Based on "listed" Date -----
  let filteredResults = results.filter(item => {
    if (item.absoluteListedDate) {
      return new Date(item.absoluteListedDate) >= CUTOFF_DATE;
    }
    return false;
  });
  
  if (filteredResults.length === 0) {
    console.log("No listings found with a 'listed' date on/after " + CUTOFF_DATE.toDateString() + ". Saving all valid listings instead.");
    filteredResults = results;
  }
  
  // Sort results by date (newest first)
  filteredResults.sort((a, b) => {
    if (!a.absoluteListedDate) return 1;
    if (!b.absoluteListedDate) return -1;
    return new Date(b.absoluteListedDate) - new Date(a.absoluteListedDate);
  });
  
  console.log(`\nFiltered Listings from ${CUTOFF_DATE.toDateString()}: ${filteredResults.length}`);
  
  // ----- Save to CSV -----
  const fields = ["title", "location", "price", "area", "description", "listed", "absoluteListedDate", "dateText", "url"];
  const csv = parse(filteredResults, { fields });
  fs.writeFileSync('results.csv', csv);
  console.log(`\n✅ Scraped ${filteredResults.length} listings with listed date on/after ${CUTOFF_DATE.toDateString()}`);
  console.log(`✅ Saved to results.csv`);
})();

