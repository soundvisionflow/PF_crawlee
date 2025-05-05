# Office Agent

A web scraper for Dubai office space sales listings, designed to collect data from multiple real estate websites.

## Current Status

The basic API infrastructure is deployed and working on Google Cloud Platform (GCP). The system is currently in Phase 1 of development, with the following components:

- **API Service**: A Cloud Run service that provides basic endpoints for health checks and a placeholder for the scraper
- **Scheduler**: A Cloud Scheduler job configured to trigger the scraper daily at 10AM UAE time (6AM UTC)
- **Storage**: A Cloud Storage bucket for storing scraped data

## API Endpoints

- `GET /` or `GET /health`: Health check endpoint
- `GET /version`: Returns version information
- `POST /scrape`: Placeholder for the scraper functionality

## Architecture

The system consists of:

1. A Node.js application running on Cloud Run that will scrape real estate websites
2. A Cloud Scheduler job that triggers the scraper daily
3. A Cloud Storage bucket for storing the scraped data

## Development Plan

The project is being developed in phases:

1. **Phase 1 (Current)**: Basic API infrastructure
2. **Phase 2**: Implement scraper functionality with anti-detection measures
3. **Phase 3**: Add monitoring, analytics, and reporting
4. **Phase 4**: Enhance features and user interface

See `implementation-plan.md` for detailed information.

## Deployment

Deployment details are documented in `deployment-summary.md`.

## Local Development

To run the project locally:

```bash
# Install dependencies
npm install

# Start the server
npm start
```

## Manual Triggering

To manually trigger the scraper:

```bash
curl -X POST https://office-agent-212383357993.asia-southeast1.run.app/scrape
```

## Future Improvements

- Implement full scraping functionality
- Add email notifications for new listings
- Create a web dashboard for viewing results
- Add support for more UAE real estate websites
- Implement a database for better historical tracking

## License

Proprietary and confidential. 