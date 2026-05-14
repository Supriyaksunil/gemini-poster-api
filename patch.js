const fs=require('fs'); 
let c=fs.readFileSync('puppeteer-cookie-bot.js','utf8'); 
const start=c.indexOf('const loginToGoogle = async (page) = 
const end=c.indexOf('const waitForInput', start); 
const newFunc=fs.readFileSync('new-login-func.js','utf8'); 
c=c.slice(0,start)+newFunc+c.slice(end); 
fs.writeFileSync('puppeteer-cookie-bot.js',c); 
console.log('Patched, size:', c.length); 
