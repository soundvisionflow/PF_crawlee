// Simple HTTP server for Cloud Run
const http = require('http');
const fs = require('fs');

// Create HTTP server to handle Cloud Run invocations
const server = http.createServer((req, res) => {
  console.log(`Received request: ${req.method} ${req.url}`);
  
  // Health check endpoint
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok',
      version: '1.0.0',
      time: new Date().toISOString()
    }));
    return;
  }
  
  // Version endpoint
  if (req.method === 'GET' && req.url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    }));
    return;
  }
  
  // Scraper trigger endpoint (POST only)
  if (req.method === 'POST' && req.url === '/scrape') {
    // Just return a successful response for now without actually running the scraper
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      message: "Scrape request accepted. Scraper functionality will be implemented soon.",
      timeReceived: new Date().toISOString()
    }));
    return;
  }
  
  // Handle all other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// Handle process shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
