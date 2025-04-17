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
const CUTOFF_DATE = new Date("2025-01-01");

// ---------- Main Execution ----------
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
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
    
    // Wait for listings to load
    await page.waitForSelector('article, div.ListingCard, div.card');
    
    // Extract listings
    const listings = await page.evaluate(() => {
      const elements = document.querySelectorAll('article, div.ListingCard, div.card');
      return Array.from(elements).map(el => {
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
        const listed = el.querySelector('[class*="listed"]')?.innerText.trim() || null;
        const url = el.querySelector('a')?.href || null;
        return { title, location, price, area, listed, url };
      });
    });
    
    // Process each listing
    for (const item of listings) {
      if (!item.area || item.area < MIN_AREA_SQFT) continue;
      
      // Get listing date
      let listedDate = null;
      if (item.listed) {
        const cleanString = item.listed.replace(/listed\s*/i, '').trim();
        listedDate = parseRelativeTime(cleanString);
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

