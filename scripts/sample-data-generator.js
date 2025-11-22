// Generate a large set of fake emails
const fs = require('fs');
const path = require('path');

const domains = ['example.com', 'corp.com', 'mybiz.io', 'gmail.com', 'yahoo.com', 'outlook.com'];

function randEmail(i) {
  const d = domains[Math.floor(Math.random() * domains.length)];
  return `user${i}.${Math.random().toString(36).slice(2,8)}@${d}`;
}

const count = Number(process.argv[2] || 10000);
const out = path.join(process.cwd(), `sample_emails_${count}.json`);
const emails = Array.from({ length: count }, (_, i) => randEmail(i));

fs.writeFileSync(out, JSON.stringify({ emails }, null, 2));
console.log('Generated:', out);