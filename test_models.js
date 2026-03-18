const args = process.argv.slice(2);
const key = args[0];

const modelsToTest = [
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-3-flash-preview"
];

async function testModel(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
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
    if (res.ok) {
        console.log(`✅ ${model} radi.`);
    } else {
        const text = await res.text();
        console.log(`❌ ${model} ne radi. Status: ${res.status}, Detalji: ${text}`);
    }
  } catch(e) {
    console.log(`❌ ${model} error: ${e.message}`);
  }
}

async function main() {
  for (const m of modelsToTest) {
    await testModel(m);
  }
}
main();
