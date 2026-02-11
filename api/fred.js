export default async function handler(req, res) {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  
  // Build FRED URL from incoming query params
  const fredParams = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    fredParams.set(key, value);
  }
  
  // Use server-side env var for API key if not provided in request
  if (!fredParams.get('api_key') && process.env.FRED_API_KEY) {
    fredParams.set('api_key', process.env.FRED_API_KEY);
  }
  
  const fredUrl = `https://api.stlouisfed.org/fred/series/observations?${fredParams}`;
  
  try {
    const response = await fetch(fredUrl);
    const data = await response.text();
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(response.status).send(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
