export default async function handler(req, res) {
  const configured = !!process.env.GOOGLE_AI_API_KEY
  res.status(200).json({ geminiEnabled: configured })
}
