FROM node:22.14.0

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright dependencies
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Copy the rest of the application
COPY . .

# Start the application
CMD ["node", "propertyfinder_office_scraper.cjs"] 