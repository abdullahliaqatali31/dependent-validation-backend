import express from 'express';
import { config } from './config';

const app = express();
app.get('/', (_req, res) => {
  res.send(`<html><body><h1>Frontend Stub</h1><p>Connect to WS at ws://localhost:${config.wsPort}</p></body></html>`);
});
app.listen(config.frontendPort, () => console.log(`Frontend stub on ${config.frontendPort}`));