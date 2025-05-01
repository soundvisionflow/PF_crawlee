# Office Agent

A Node.js scraper for extracting office space listings from Property Finder UAE.

## Features

- Extracts office space listings with area >= 1500 sqft
- Filters listings from the last 2 months
- Sorts results by newest first
- Saves data to CSV format
- Uses stealth mode to avoid detection
- Handles pagination automatically

## Deployment

This project is configured to run on Render.com as a worker service. The deployment process:

1. Automatically installs Chrome using the build script
2. Sets up Node.js environment
3. Installs dependencies
4. Runs the scraper continuously

## Environment Variables

- `NODE_VERSION`: Set to 18.x
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`: Set to true (using system Chrome)

## Output

Results are saved to `results.csv` with the following fields:
- Title
- Location
- Price
- Area (sqft)
- Description
- Listed Date
- URL 