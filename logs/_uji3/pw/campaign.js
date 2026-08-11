const { chromium } = require("playwright");
const OUT = "/home/iqball/drone-stack/logs/_uji3";

/**
 * Kampanye uji: 10 skenario dengan jarak target 2,4,...,20 m.
 *
 * Klik peta dikalibrasi lebih dulu — skala meter/piksel dibaca dari label
 * "Jarak ke waypoint" yang dihitung aplikasi sendiri, bukan diasumsikan dari
 * rumus zoom. Dengan begitu perbedaan zoom/latitude tidak membuat jarak target
 * meleset dari angka yang diinginkan.
 */
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[missions]")) console.log("   APP:", t.slice(0, 120));
  });

  await page.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await page.fill("#username", "operator1");
  await page.fill("#password", "rahasia123");
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=DRONE-STACK MONOREPO", { timeout: 45000 });
  console.log("login OK");

  const map = page.locator(".leaflet-container").first();
  await map.waitFor({ timeout: 15000 });
  await page.waitForTimeout(4000);

  // "Follow Drone" -> drone selalu di TENGAH peta, sehingga offset piksel klik
  // selalu diukur dari posisi drone, berapa pun ia sudah berpindah.
  const follow = page.getByText("Follow Drone", { exact: false }).first();
  await follow.click();
  await page.waitForTimeout(2500);

  let box = await map.boundingBox();
  let cx = box.x + box.width / 2;
  let cy = box.y + box.height / 2;

  /** Pasang marker pada offset piksel tertentu, baca koordinat target (m). */
  async function probeDistance(dxPx) {
    await page.mouse.click(cx + dxPx, cy);
    await page.waitForTimeout(1200);
    const txt = await page.locator("text=/Target:/").first().innerText();
    const m = txt.match(/\(([-\d.]+),\s*([-\d.]+)\)/);
    if (!m) throw new Error("tidak bisa membaca koordinat target: " + txt);
    return Math.hypot(parseFloat(m[1]), parseFloat(m[2]));
  }

  /**
   * Cari zoom yang pas lewat KALIBRASI BERULANG, bukan rumus.
   *
   * Satu langkah roda di Leaflet = 60 px delta (wheelPxPerZoomLevel); memakai
   * -400 seperti percobaan sebelumnya melompat ~7 level sekaligus, langsung
   * mentok zoom maksimum sehingga 200 px hanya bernilai 0,28 m dan seluruh
   * skenario meleset. Target skala: 20 m masih muat di ~300 px.
   */
  const TARGET_MPP = 0.07;
  let metersPerPx = (await probeDistance(200)) / 200;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (metersPerPx <= TARGET_MPP * 1.6 && metersPerPx >= TARGET_MPP * 0.4) break;
    const zoomIn = metersPerPx > TARGET_MPP;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, zoomIn ? -60 : 60);
    await page.waitForTimeout(1100);
    box = await map.boundingBox();
    cx = box.x + box.width / 2;
    cy = box.y + box.height / 2;
    metersPerPx = (await probeDistance(200)) / 200;
    console.log(`  kalibrasi ulang -> ${metersPerPx.toFixed(4)} m/px`);
  }
  console.log(`skala final: ${metersPerPx.toFixed(4)} m/px (20 m = ${Math.round(20/metersPerPx)} px)`);

  const results = [];
  for (const targetM of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]) {
    const dxPx = Math.round(targetM / metersPerPx);
    if (dxPx < 6) { console.log(`  ${targetM} m -> hanya ${dxPx} px, terlalu kasar`); }

    await page.mouse.click(cx + dxPx, cy);
    await page.waitForTimeout(1500);

    const btn = page.getByRole("button", { name: /send goal/i }).first();
    if (await btn.isDisabled()) { console.log(`  ${targetM} m: Send Goal disabled, dilewati`); continue; }
    const t0 = Date.now();
    await btn.click();

    // Tunggu sampai tiba: 1 m/s + margin.
    await page.waitForTimeout((targetM / 1.0) * 1000 + 7000);
    console.log(`  target ${targetM} m -> ${dxPx} px, selesai dalam ${((Date.now()-t0)/1000).toFixed(0)}s`);
    results.push({ targetM, dxPx });
  }

  await page.screenshot({ path: `${OUT}/akhir.png` });
  console.log("kampanye selesai:", results.length, "skenario");
  await browser.close();
})().catch((e) => { console.error("GAGAL:", e.message); process.exit(1); });
