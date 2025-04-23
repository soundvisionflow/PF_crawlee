// propertyfinder_office_scraper.cjs

const puppeteer = require('puppeteer');
const fs = require('fs');
const { parse } = require('json2csv');

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

// ---------- Configuration ----------
const START_URL = 'https://www.propertyfinder.ae/en/search?l=1&c=3&t=4&fu=0&af=1500&ob=nd';
const MIN_AREA_SQFT = 1500;
const MONTHS_TO_LOOKBACK = 2;
const CUTOFF_DATE = (() => {
  const date = new Date();
  date.setMonth(date.getMonth() - MONTHS_TO_LOOKBACK);
  return date;
})();

// ---------- Main Execution ----------
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  const results = [];
  let currentPage = 1;
  let hasNextPage = true;
  
  while (hasNextPage) {
    console.log(`Processing page ${currentPage}`);
    
    // Navigate to the page
    const url = currentPage === 1 ? START_URL : `${START_URL}&page=${currentPage}`;
    await page.goto(url, { waitUntil: 'networkidle0' });
    
    // Wait for listings to load (broadened selectors)
    await page.waitForSelector('li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]');
    
    // Debug: count how many listing elements are found
    const elementCount = await page.$$eval('li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]', els => els.length);
    console.log(`Total listing elements found: ${elementCount}`);
    
    // Debug: on first page, print first listing element HTML for inspection
    if (currentPage === 1 && elementCount > 0) {
      const firstHTML = await page.$eval('li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]', el => el.outerHTML);
      console.log('First listing HTML for debugging:', firstHTML);
    }
    
    // Extract listings
    const listings = await page.evaluate(() => {
      const elements = document.querySelectorAll('li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]');
      return Array.from(elements).map(el => {
        const title = el.querySelector('h2')?.innerText.trim() || null;
        const location = el.querySelector('[class*="location"]')?.innerText.trim() || null;
        const price = el.querySelector('[class*="price"]')?.innerText.trim() || null;
        let area = null;
        const allTexts = Array.from(el.querySelectorAll('*')).map(e => e.innerText || '');
        for (const txt of allTexts) {
          const match = txt.replace(/,/g, '').match(/(\d+)\s*sq[\s\.]*ft/i);
          if (match) {
            area = parseInt(match[1], 10);
            break;
          }
        }
        // Extract listing date from <time> tag or page text
        let listed = el.querySelector('time')?.innerText.trim() || el.querySelector('time')?.getAttribute('datetime') || null;
        if (!listed) {
          for (const raw of allTexts) {
            const txt = raw.replace(/\s+/g, ' ').trim();
            if (/\d+\s*(minute|hour|day|week|month|year)s?\s+ago/i.test(txt) || !isNaN(Date.parse(txt))) {
              listed = txt;
              break;
            }
          }
        }
        const url = el.querySelector('a')?.href || null;
        return { title, location, price, area, listed, url };
      });
    });
    
    // Debug: print first 5 raw listings
    console.log('Raw listings sample:', JSON.stringify(listings.slice(0, 5), null, 2));
    
    // Process each listing
    for (const item of listings) {
      if (!item.area || item.area < MIN_AREA_SQFT) continue;
      
      // Get listing date
      let listedDate = null;
      if (item.listed) {
        const cleanString = item.listed.replace(/listed\s*/i, '').trim();
        // Try relative time parsing
        listedDate = parseRelativeTime(cleanString);
        // Fallback to absolute date parsing
        if (!listedDate) {
          const absDate = new Date(cleanString);
          if (!isNaN(absDate)) {
            listedDate = absDate;
          }
        }
      }
      
      // Check if listing is within date range
      if (listedDate && listedDate >= CUTOFF_DATE) {
        // Visit detail page
        if (item.url) {
          const detailPage = await browser.newPage();
          await detailPage.goto(item.url, { waitUntil: 'networkidle0' });
          
          // Extract description
          const description = await detailPage.evaluate(() => {
            const descEl = document.querySelector('#description');
            if (descEl) {
              const button = descEl.querySelector('button');
              if (button) button.click();
              return descEl.innerText.trim();
            }
            return null;
          });
          
          item.description = description;
          await detailPage.close();
        }
        
        results.push(item);
        console.log(`Found valid listing: ${item.title}`);
      }
    }
    
    // Check for next page
    const nextButton = await page.$('a[aria-label="Next"]');
    hasNextPage = !!nextButton;
    currentPage++;
    
    // Add delay between pages
    await page.waitForTimeout(2000);
  }
  
  await browser.close();
  
  // Save results to CSV
  const fields = ['title', 'location', 'price', 'area', 'description', 'listed', 'url'];
  const csv = parse(results, { fields });
  fs.writeFileSync('results.csv', csv);
  
  console.log(`Scraping completed. Found ${results.length} valid listings.`);
})();

