export default async function handler(req, res) {
  const configured = !!process.env.ANTHROPIC_API_KEY
  res.status(200).json({ aiEnabled: configured, geminiEnabled: configured })
}
