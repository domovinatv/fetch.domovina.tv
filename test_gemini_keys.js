#!/usr/bin/env node

/**
 * Jednostavna skripta za provjeru ispravnosti Gemini API ključeva.
 * Pokretanje: node test_gemini_keys.js KLJUC1,KLJUC2,KLJUC3
 */

const args = process.argv.slice(2);
const keysArg = args[0];

if (!keysArg) {
  console.error("Korištenje: node test_gemini_keys.js KLJUČ1,KLJUČ2,...");
  process.exit(1);
}

const keys = keysArg.split(",").map(k => k.trim()).filter(Boolean);

async function testKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${key}`;
  const payload = {
    contents: [{ parts: [{ text: "Hello" }] }],
    generationConfig: { maxOutputTokens: 1 }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const maskedKey = key.substring(0, 12) + "...";
    
    if (res.ok) {
        console.log(`✅ Ključ ${maskedKey} je ISPRAVAN i uspješno dohvaća podatke!`);
    } else {
        const errText = await res.text();
        let errMsg = errText;
        try {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error ? errJson.error.message : errText;
        } catch(e) {}
        
        console.log(`❌ Ključ ${maskedKey} NIJE ISPRAVAN! Status: ${res.status}`);
        console.log(`   Razlog: ${errMsg}`);
    }
  } catch (err) {
      console.log(`❌ Greška konekcije pri testiranju ključa ${key.substring(0, 12)}... : ${err.message}`);
  }
}

async function main() {
  console.log(`\n🔍 Pokrećem testiranje za ${keys.length} Gemini API ključ(a)...\n`);
  for (const key of keys) {
    await testKey(key);
  }
  console.log(`\n🏁 Završeno!`);
}

main();
