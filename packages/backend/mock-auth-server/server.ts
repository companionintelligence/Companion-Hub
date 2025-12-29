import express from 'express';
import path from 'path';
import fs from 'fs';

const app = express();
const port = 3001;

// Hardcoded list of valid UUIDs for testing
const VALID_UUIDS = [
  'test-uuid-1234',
  'valid-hardware-uuid'
];

app.get('/download', (req, res) => {
  const uuid = req.headers['x-uuid'] as string;
  const authKey = req.headers['authorization'];

  console.log(`Received download request. UUID: ${uuid}, Auth: ${authKey}`);

  if (!uuid || !VALID_UUIDS.includes(uuid)) {
    console.log('Invalid UUID');
    return res.status(403).send('Forbidden: Invalid Hardware UUID');
  }

  const zipPath = path.join(__dirname, 'repo.zip');

  if (!fs.existsSync(zipPath)) {
    console.log('Repo zip not found');
    return res.status(404).send('Repo zip not found');
  }

  res.download(zipPath, 'repo.zip');
});

app.listen(port, () => {
  console.log(`Mock Auth Server listening at http://localhost:${port}`);
});
