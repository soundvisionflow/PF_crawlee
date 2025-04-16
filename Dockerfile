FROM node:22.14.0

# Install Chrome directly from Google
RUN apt-get update && apt-get install -y wget gnupg2 apt-transport-https ca-certificates
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
RUN sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list'
RUN apt-get update && apt-get install -y google-chrome-stable

# Verify installation and display paths
RUN which google-chrome-stable
RUN google-chrome-stable --version
RUN ls -la /usr/bin/google-chrome*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Start the application
CMD ["node", "propertyfinder_office_scraper.cjs"] 