export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { imageUrl, docType } = req.body;

    // ── Mode 1: fetch image + OCR in one server-side call ──────────────────
    if (imageUrl) {
      // Fetch the image server-side (no CORS restrictions here)
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Image fetch failed: HTTP ${imgRes.status}`);

      const arrayBuffer = await imgRes.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      const contentType = imgRes.headers.get("content-type") || "image/jpeg";
      const mimeType = contentType.startsWith("image/") || contentType === "application/pdf"
        ? contentType
        : imageUrl.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

      const prompts = {
        id_proof: `You are an OCR engine for KYC verification. Extract information from this ID document.
Return ONLY valid JSON (no markdown, no extra text):
{
  "document_type": "Aadhaar|PAN|Voter ID|Driving License|Passport|Ration Card|Birth Certificate|Other",
  "document_number": "extracted number or null",
  "full_name": "full name as printed on document or null",
  "date_of_birth": "DOB if visible or null",
  "additional_info": "any other relevant text or null"
}`,
        relationship_proof: `You are an OCR engine for KYC verification. Extract information from this relationship proof document.
Return ONLY valid JSON (no markdown, no extra text):
{
  "document_type": "Birth Certificate|Ration Card|SSLC Marks Card|Marriage Certificate|Passport|Other",
  "names_found": ["all","names","visible","in","document"],
  "relationship_mentioned": "relationship if explicitly stated or null",
  "beneficiary_name": "name identified as beneficiary/patient/child if determinable or null",
  "recipient_name": "name identified as parent/guardian/relative if determinable or null",
  "additional_info": "any other relevant text or null"
}`,
        pan_proof: `You are an OCR engine for KYC verification. Extract information from this PAN card.
Return ONLY valid JSON (no markdown, no extra text):
{
  "document_type": "PAN",
  "pan_number": "10-character PAN number or null",
  "full_name": "name as printed on PAN or null",
  "father_name": "father's name if visible or null",
  "date_of_birth": "DOB if visible or null"
}`,
      };

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
              { type: "text", text: prompts[docType] || prompts.id_proof }
            ]
          }]
        })
      });

      const data = await claudeRes.json();
      return res.status(claudeRes.status).json(data);
    }

    // ── Mode 2: plain Claude API call (no image) ───────────────────────────
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await claudeRes.json();
    return res.status(claudeRes.status).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
