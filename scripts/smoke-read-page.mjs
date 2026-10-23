import { readWebsite } from "../src/webshot.js";
for (const url of ["https://www.douyin.com/video/7698217103421099304", "https://www.douyin.com/hot"]) {
  const r = await readWebsite({ url, waitMs: 12000, maxChars: 1500 });
  console.log(`\n=== ${url}\n site=${r.site} chars=${r.chars} author=${JSON.stringify(r.author)} statLine=${JSON.stringify(r.statLine)} videoLinks=${r.videoLinks.length}`);
  console.log(`desc=${JSON.stringify(r.desc).slice(0,200)}`);
  console.log(r.text.slice(0, 1200));
}

