import './config/bootstrap-env.mjs';
import { createApp } from './api/app.mjs';
import { getDb } from './storage/db.mjs';

const port = Number(process.env.PORT || 3000);
const app = createApp(getDb());

app.listen(port, () => {
  console.log(`js-deepresearch-agent listening on http://127.0.0.1:${port}`);
});
