#!/bin/bash

# Check if we're on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Detected macOS system"
    
    # Check if Chrome is already installed via Homebrew
    if ! command -v google-chrome &> /dev/null; then
        echo "Chrome not found, installing via Homebrew..."
        brew install --cask google-chrome
    fi
    
    # Set Chrome path for macOS
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [ ! -f "$CHROME_PATH" ]; then
        echo "Chrome not found at $CHROME_PATH"
        exit 1
    fi
else
    # Linux installation (keeping as fallback)
    echo "Installing Chrome for Linux..."
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
    sudo apt-get update
    sudo apt-get install -y google-chrome-stable
    CHROME_PATH=$(which google-chrome-stable)
fi

echo "Chrome found at: $CHROME_PATH"
export PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH

# Install dependencies
echo "Installing Node.js dependencies..."
npm install

echo "Build completed successfully!" 