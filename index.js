require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const SERVICES = `Classic Manicure $45/30min, Gel Manicure $75/1hr, Kids Manicure $20, Teen Manicure $25, Classic Pedicure $75/1hr, Gehwol Pedicure $100/1hr15min, Kids Pedicure $40, Teen Pedicure $50, Senior Mani-Pedi $130/1hr45min, Kids Mani-Pedi $55, Teen Mani-Pedi $70, French Design $15, Polish Change Fingers $25, Polish Change Toes $45, Remove Acrylic $30, 10min Massage $25, Eyebrow wax $30, Lip wax $20, Chin wax $20. Travel fee applies. NO acrylics.`;

function getGoogleAuth() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function getAppointments() {
  const auth = getGoogleAuth();
  const cal = google.calendar({ version: "v3", auth });
  const now = new Date();
  const s = new Date(now); s.setHours(0,0,0,0);
  const e = new Date(now); e.setDate(e.getDate()+1); e.setHours(23,59,59,999);
  const res = await cal.events.list({ calendarId: "primary", timeMin: s.toISOString(), timeMax: e.toISOString(), singleEvents: true, orderBy: "startTime" });
  return (res.data.items||[]).map(ev=>({ title: ev.summary, start: ev.start.dateTime, address: ev.location||"" }));
}

async function bookAppointment(name, service, address, dt, mins) {
  const auth = getGoogleAuth();
  const cal = google.calendar({ version: "v3", auth });
  const start = new Date(dt), end = new Date(start.getTime()+mins*60000);
  await cal.events.insert({ calendarId: "primary", resource: {
    summary: `Pamper Me - ${name} (${service})`, location: address,
    start: { dateTime: start.toISOString(), timeZone: "America/New_York" },
    end: { dateTime: end.toISOString(), timeZone: "America/New_York" }
  }});
}

async function analyzeMessage(msg, appts) {
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",timeZone:"America/New_York"});
  const time = new Date().toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit"});
  const apptList = appts.length>0 ? appts.map(a=>`- ${a.title} at ${a.start}`).join("\n") : "None";

  const prompt = `You are a booking assistant for Pamper Me Mobile Nails & Spa (owner: Diana, Philadelphia area).
TODAY: ${today} ${time} Eastern. Hours: Tue-Fri 9:30am-5pm, Sat 10am-5pm, CLOSED Sun/Mon.
RULES: Only book today/tomorrow. No acrylics. Ask for address if missing. Reply in same language as message. Be warm 💅. Travel fee applies.
SERVICES: ${SERVICES}
CURRENT APPOINTMENTS: ${apptList}
MESSAGE: "${msg}"
Respond ONLY with valid JSON (no markdown, no backticks):
{"language":"en","needs_address":false,"detected_address":null,"client_email":null,"appointment_requested":false,"acrylic_requested":false,"client_name":null,"service_requested":null,"service_duration_mins":60,"proposed_datetime":null,"reply":"response here"}`;

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(prompt);
  let text = result.response.text().trim();
  text = text.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim();
  return JSON.parse(text);
}

async function processMessage(text, appts) {
  const a = await analyzeMessage(text, appts);
  if (a.appointment_requested && !a.acrylic_requested && a.detected_address && a.proposed_datetime && a.client_name) {
    try {
      await bookAppointment(a.client_name, a.service_requested||"Nail Service", a.detected_address, a.proposed_datetime, a.service_duration_mins||60);
      console.log(`✅ Booked: ${a.client_name}`);
    } catch(e) { console.error("⚠️ Calendar:", e.message); }
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
      imap.openBox("INBOX", false, err => {
        if (err) return reject(err);
        imap.search(["UNSEEN"], (err, uids) => {
          if (err) return reject(err);
          if (!uids||uids.length===0) { imap.end(); return resolve([]); }
          const f = imap.fetch(uids.slice(0,5), { bodies:"", markSeen:true });
          f.on("message", msg => {
            let buf="";
            msg.on("body", stream => {
              stream.on("data", c => buf+=c.toString("utf8"));
              stream.once("end", async () => {
                const p = await simpleParser(buf);
                results.push({ from: p.from?.text||"", replyTo: p.replyTo?.text||p.from?.text||"", subject: p.subject||"", body: p.text||"" });
              });
            });
          });
          f.once("end", () => setTimeout(()=>{ imap.end(); resolve(results); }, 1000));
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

async function sendReply(to, subject, text) {
  const t = nodemailer.createTransport({ host: "smtp.mail.yahoo.com", port: 465, secure: true, auth: { user: process.env.YAHOO_EMAIL, pass: process.env.YAHOO_APP_PASSWORD } });
  await t.sendMail({
    from: `Pamper Me Mobile Nails <${process.env.YAHOO_EMAIL}>`,
    to, subject: subject.startsWith("Re:")?subject:`Re: ${subject}`,
    text: `${text}\n\n---\nPamper Me Mobile Nails & Spa\n📱 215-490-1515\n🌐 pampermemobilenails.com\n📸 @pamperme.mobile.nails`
  });
}

app.post("/webhook/sms", async (req, res) => {
  const body=req.body.Body||"", from=req.body.From||"";
  console.log(`💬 SMS from ${from}: ${body}`);
  try {
    const appts = await getAppointments().catch(()=>[]);
    const a = await processMessage(body, appts);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(a.reply);
    res.type("text/xml").send(twiml.toString());
  } catch(err) { console.error("❌ SMS:", err.message); res.status(500).send("Error"); }
});

app.post("/webhook/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const g = twiml.gather({ input:"speech", action:"/webhook/voice/process", method:"POST", language:"en-US", speechTimeout:"auto" });
  g.say({ voice:"Polly.Joanna" }, "Thank you for calling Pamper Me Mobile Nails! How can I help you today? Gracias por llamar a Pamper Me. ¿En qué le puedo ayudar?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/webhook/voice/process", async (req, res) => {
  const speech=req.body.SpeechResult||"", caller=req.body.From||"";
  const twiml = new twilio.twiml.VoiceResponse();
  try {
    const appts = await getAppointments().catch(()=>[]);
    const a = await processMessage(speech, appts);
    twiml.say({ voice: a.language==="es"?"Polly.Conchita":"Polly.Joanna" }, a.reply);
    if (a.appointment_requested && a.proposed_datetime) {
      await getTwilioClient().messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: caller, body: `✅ Pamper Me: Appointment confirmed! 💅 ${a.service_requested||"Nail Service"} at ${a.detected_address}. Questions: 215-490-1515` });
    }
  } catch(err) { twiml.say({ voice:"Polly.Joanna" }, "Sorry, please text 215-490-1515 to book."); }
  res.type("text/xml").send(twiml.toString());
});

async function checkYahooMail() {
  try {
    const emails = await getUnreadEmails();
    if (emails.length===0) { console.log("📭 No new emails"); return; }
    console.log(`📧 ${emails.length} new email(s)`);
    const appts = await getAppointments().catch(()=>[]);
    for (const email of emails) {
      try {
        const a = await processMessage(email.body||email.subject, appts);
        const to = email.replyTo||email.from;
        await sendReply(to, email.subject, a.reply);
        console.log(`✉️ Reply sent to ${to}`);
      } catch(e) { console.error(`❌ Email error:`, e.message); }
    }
  } catch(err) { console.error("❌ Yahoo check:", err.message); }
}

setInterval(checkYahooMail, 5*60*1000);
app.get("/", (req, res) => res.send("<h2>💅 Pamper Me Agent — Active (Gemini)</h2>"));

const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`🚀 Pamper Me Agent running on port ${PORT}`);
  console.log(`📧 Checking Yahoo Mail every 5 minutes...`);
  checkYahooMail();
});
