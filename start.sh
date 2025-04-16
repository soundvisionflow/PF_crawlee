#!/bin/bash

# Install Playwright browser and dependencies
echo "Installing Playwright and dependencies..."
PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/.playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/.playwright npx playwright install-deps chromium

# Run the scraper
echo "Starting the scraper..."
node propertyfinder_office_scraper.cjs 