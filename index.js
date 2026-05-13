// AGENTE DE CITAS — PAMPER ME MOBILE NAILS & SPA
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BUSINESS = {
  name: "Pamper Me Mobile Nails & Spa", owner: "Diana",
  phone: "215-490-1515", email: "DiaNails19@yahoo.com",
  coverage: ["Montgomery County", "Bucks County", "Delaware County", "Chester County", "Philadelphia", "parts of New Jersey"],
  services: `
MANICURES: Classic $45/30min, Gel $75/1hr, Kids $20, Teen $25
PEDICURES: Classic $75/1hr, Gehwol $100/1hr15min, Kids $40, Teen $50, Senior Mani-Pedi $130/1hr45min
COMBOS: Kids Mani/Pedi $55, Teen Mani/Pedi $70
ADD-ONS: French Design $15, Polish Change Fingers $25, Polish Change Toes $45, Remove Acrylic $30, 10min Massage $25
WAXING: Eyebrow $30, Lip $20, Chin $20
NOTE: Travel fee applies. Natural nails ONLY — NO acrylics.`
};

function getGoogleAuth() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function getUpcomingAppointments() {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  const end = new Date(now); end.setDate(end.getDate()+1); end.setHours(23,59,59,999);
  const res = await calendar.events.list({ calendarId: "primary", timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: "startTime" });
  return (res.data.items||[]).map(e=>({ title: e.summary, start: e.start.dateTime, address: e.location||"" }));
}

async function createAppointment(name, service, address, dt, mins) {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const start = new Date(dt), end = new Date(start.getTime()+mins*60000);
  await calendar.events.insert({ calendarId: "primary", resource: {
    summary: `Pamper Me - ${name} (${service})`, location: address,
    start: { dateTime: start.toISOString(), timeZone: "America/New_York" },
    end: { dateTime: end.toISOString(), timeZone: "America/New_York" }
  }});
}

async function analyzeMessage(msg, appointments) {
  const appts = appointments.length > 0 ? appointments.map(a=>`- ${a.title} at ${a.start}`).join("\n") : "No appointments yet.";
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",timeZone:"America/New_York"});
  const time = new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"});

  const prompt = `You are a booking assistant for Pamper Me Mobile Nails & Spa (owner: Diana).
TODAY: ${today}, ${time} Eastern Time
RULES: Only book today/tomorrow. Hours: Tue-Fri 9:30am-5pm, Sat 10am-5pm, closed Sun/Mon. No acrylics. Ask for address if missing. Detect language and reply in same language. Be warm, use emoji 💅. Travel fee applies.
SQUARESPACE FORMS: Extract NAME/PHONE/EMAIL/ADDRESS/SERVICE automatically.
SERVICES: ${BUSINESS.services}
APPOINTMENTS: ${appts}
MESSAGE: "${msg}"
Reply ONLY with JSON (no backticks): {"language":"en","needs_address":false,"detected_address":null,"client_email":null,"appointment_requested":false,"acrylic_requested":false,"client_name":null,"service_requested":null,"service_duration_mins":60,"proposed_datetime":null,"zone_ok":true,"reply":"your reply here"}`;

  const response = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, messages: [{ role: "user", content: prompt }] });
  return JSON.parse(response.content[0].text.replace(/```json|```/g,"").trim());
}

async function processMessage(text, appointments) {
  const a = await analyzeMessage(text, appointments);
  if (a.appointment_requested && !a.acrylic_requested && a.detected_address && a.proposed_datetime && a.client_name) {
    try { await createAppointment(a.client_name, a.service_requested||"Nail Service", a.detected_address, a.proposed_datetime, a.service_duration_mins||60); console.log(`✅ Agendado: ${a.client_name}`); }
    catch(e) { console.error("⚠️ Calendar error:", e.message); }
  }
  return a;
}

function getImap() {
  return new Imap({ user: process.env.YAHOO_EMAIL, password: process.env.YAHOO_APP_PASSWORD, host: "imap.mail.yahoo.com", port: 993, tls: true, tlsOptions: { rejectUnauthorized: false } });
}

async function getUnreadEmails() {
  return new Promise((resolve, reject) => {
    const imap = getImap(); const results = [];
    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) return reject(err);
        imap.search(["UNSEEN"], (err, uids) => {
          if (err) return reject(err);
          if (!uids || uids.length===0) { imap.end(); return resolve([]); }
          const fetch = imap.fetch(uids.slice(0,5), { bodies: "", markSeen: true });
          fetch.on("message", (msg) => {
            let buf = "";
            msg.on("body", (stream) => { stream.on("data", c => buf+=c.toString("utf8")); stream.once("end", async () => { const p = await simpleParser(buf); results.push({ from: p.from?.text||"", replyTo: p.replyTo?.text||p.from?.text||"", subject: p.subject||"", body: p.text||"" }); }); });
          });
          fetch.once("end", () => { setTimeout(()=>{ imap.end(); resolve(results); }, 1000); });
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

async function sendReply(to, subject, replyText) {
  const auth = getGoogleAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const fullText = `${replyText}\n\n---\nPamper Me Mobile Nails & Spa\n📱 215-490-1515\n🌐 pampermemobilenails.com`;
  const subj = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const raw = Buffer.from(
    `To: ${to}\nSubject: ${subj}\nContent-Type: text/plain; charset=utf-8\n\n${fullText}`
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  await gmail.users.messages.send({ userId: "me", resource: { raw } });
}

app.post("/webhook/sms", async (req, res) => {
  const body = req.body.Body||"", from = req.body.From||"";
  console.log(`💬 SMS de ${from}: ${body}`);
  try {
    const appts = await getUpcomingAppointments().catch(()=>[]);
    const a = await processMessage(body, appts);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(a.reply);
    res.type("text/xml").send(twiml.toString());
  } catch(err) { console.error("❌ SMS:", err.message); res.status(500).send("Error"); }
});

app.post("/webhook/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const g = twiml.gather({ input: "speech", action: "/webhook/voice/process", method: "POST", language: "en-US", speechTimeout: "auto" });
  g.say({ voice: "Polly.Joanna" }, "Thank you for calling Pamper Me Mobile Nails! How can I help you? Gracias por llamar a Pamper Me. ¿En qué le puedo ayudar?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/webhook/voice/process", async (req, res) => {
  const speech = req.body.SpeechResult||"", caller = req.body.From||"";
  const twiml = new twilio.twiml.VoiceResponse();
  try {
    const appts = await getUpcomingAppointments().catch(()=>[]);
    const a = await processMessage(speech, appts);
    twiml.say({ voice: a.language==="es"?"Polly.Conchita":"Polly.Joanna" }, a.reply);
    if (a.appointment_requested && a.proposed_datetime) {
      await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: caller, body: `✅ Pamper Me: Appointment confirmed! 💅 ${a.service_requested||"Nail Service"} at ${a.detected_address}. Questions: 215-490-1515` });
    }
  } catch(err) { twiml.say({ voice: "Polly.Joanna" }, "Sorry, please text 215-490-1515 to book."); }
  res.type("text/xml").send(twiml.toString());
});

async function checkYahooMail() {
  try {
    const emails = await getUnreadEmails();
    if (emails.length===0) { console.log("📭 No hay correos nuevos"); return; }
    console.log(`📧 ${emails.length} correo(s) nuevo(s) en Yahoo`);
    const appts = await getUpcomingAppointments().catch(()=>{ console.log("⚠️ Calendar no disponible"); return []; });
    for (const email of emails) {
      try {
        console.log(`📨 Procesando de: ${email.from}`);
        const a = await processMessage(email.body||email.subject, appts);
        console.log(`🤖 Respuesta lista`);
        const to = email.replyTo||email.from;
        console.log(`📤 Enviando a: ${to}`);
        await sendReply(to, email.subject, a.reply);
        console.log(`✉️ Respuesta enviada a ${to}`);
      } catch(e) { console.error(`❌ Error correo:`, e.message, e.stack); }
    }
  } catch(err) { console.error("❌ Yahoo check:", err.message, err.stack); }
}

setInterval(checkYahooMail, 5 * 60 * 1000);

app.get("/", (req, res) => res.send("<h2>💅 Pamper Me Agent — Active</h2>"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Pamper Me Agent running on port ${PORT}`);
  console.log(`📧 Checking Yahoo Mail every 5 minutes...`);
  checkYahooMail();
});
