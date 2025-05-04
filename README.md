# Office Agent

A Node.js scraper for extracting office space listings for sale in Dubai.

## Features

- Extracts office space listings with area >= 1500 sqft
- Filters listings from multiple real estate websites
- Sorts results by newest first
- Saves data to CSV format
- Uses stealth mode to avoid detection
- Handles pagination automatically
- Supports initial database creation and daily updates

## Supported Sites

- PropertyFinder UAE
- Bayut UAE
- Dubizzle UAE

## Usage

To create initial database (looks back 2 months):
```
npm run initial
```

For daily updates (since last run):
```
npm run daily
```

For testing:
```
npm run test:pages
```

## Deployment

This project is configured to run on Google Cloud Run as a service. The deployment process:

1. Automatically installs Chrome using the build script
2. Sets up Node.js environment
3. Installs dependencies
4. Runs the scraper based on schedule

## Environment Variables

- `NODE_VERSION`: Set to 18.x or higher
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`: Set to true (using system Chrome)
- `BUCKET_NAME`: GCS bucket name for storing results
- `MODE`: "initial" or "update" (determines scraping scope)

## Output

Results are saved to `results.csv` and uploaded to Google Cloud Storage with the following fields:
- Title
- Location
- Price
- Area (sqft)
- Description
- Listed Date
- URL 