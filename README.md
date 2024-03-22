# Tellinki
**Simple map of Helsinki Bicycle Parking**

Tellinki.com is a static PWA website, utilizing leaflet.js and OpenStreetMap database for showing different types of bicycle parking in Helsinki.

## Development

For local development the easiest way is to open the project folder and run `python -m http.server 8000` (python3). The site should be accessible at `localhost:8000`.

## Deployment

The website is hosted on Github Pages with Tellinki Github account. Simply push the changes and the site should be updated. The site is available at [www.tellinki.com](https://www.tellinki.com).

## Hosting

The website domain is registered at Namecheap and DNS is handled with Cloudflare. The site has forced HTTPS on. The site may utilize some platform features such as location to help users locate themselves on the map.

## Contribution

For any code changes, simply create a PR. For improving the data accuracy, edit the OpenStreetMap database.
