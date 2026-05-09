// ============================================
// AGENTE DE CITAS — PAMPER ME MOBILE NAILS & SPA
// Diana Llanos | pampermemobilenails.com
// ============================================
// Canales: Llamadas (voz) + SMS + Yahoo (vía Gmail reenvío)
// Idiomas: Inglés y Español (detección automática)
// Cobertura: Montgomery, Bucks, Delaware, Chester, Philadelphia + partes de NJ
// Regla clave: máximo 20 min de viaje entre citas del mismo día

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// INFORMACIÓN REAL DEL NEGOCIO
// ─────────────────────────────────────────────
const BUSINESS = {
  name: "Pamper Me Mobile Nails & Spa",
  owner: "Diana",
  phone: "215-490-1515",
  email: "DiaNails19@yahoo.com",
  website: "pampermemobilenails.com",
  instagram: "@pamperme.mobile.nails",
  coverage: ["Montgomery County", "Bucks County", "Delaware County", "Chester County", "Philadelphia", "parts of New Jersey"],
  hours: {
    tue: { open: "09:30", close: "17:00" },
    wed: { open: "09:30", close: "17:00" },
    thu: { open: "09:30", close: "17:00" },
    fri: { open: "09:30", close: "17:00" },
    sat: { open: "10:00", close: "17:00" },
    // closed sunday and monday
  },
  maxAppointmentsPerDay: 3,
  maxTravelMinutes: 20,
  noAcrylic: true, // IMPORTANT: natural nails only
  services: `
MANICURES:
- Classic Manicure: $45 | 30 min
- Gel Manicure: $75 | 1 hour (natural nails, no acrylic)
- Kids Manicure (under 9): $20
- Teen Manicure (10-16): $25

PEDICURES:
- Classic Pedicure: $75 | 1 hour
- Gehwol Pedicure (dry/cracked skin): $100 | 1 hour 15 min
- Kids Pedicure (under 9): $40
- Teen Pedicure (10-16): $50
- Senior Mani-Pedi: $130 | 1 hour 45 min

COMBO:
- Kids Mani/Pedi: $55
- Teen Mani/Pedi: $70

ADD-ONS:
- French Design: $15
- Polish Change (Fingers): $25
- Polish Change (Toes): $45
- Remove Acrylic: $30
- 10 Minute Massage: $25

WAXING:
- Eyebrow wax: $30
- Lip wax: $20
- Chin wax: $20

NOTE: Travel fee applies to all services. We do NOT do acrylic nails — natural nails only.
  `
};

// ─────────────────────────────────────────────
// GOOGLE AUTH
// ─────────────────────────────────────────────
function getGoogleAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

// ─────────────────────────────────────────────
// GOOGLE CALENDAR
// ─────────────────────────────────────────────
async function getUpcomingAppointments() {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setDate(end.getDate() + 1);
  end.setHours(23, 59, 59, 999);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items || []).map((e) => ({
    title: e.summary,
    start: e.start.dateTime,
    address: e.location || "",
  }));
}

async function createAppointment(clientName, service, address, dateTimeISO, durationMins) {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(dateTimeISO);
  const end = new Date(start.getTime() + durationMins * 60000);

  await calendar.events.insert({
    calendarId: "primary",
    resource: {
      summary: `Pamper Me - ${clientName} (${service})`,
      location: address,
      description: `Booked via agent. Client: ${clientName}. Service: ${service}.`,
      start: { dateTime: start.toISOString(), timeZone: "America/New_York" },
      end: { dateTime: end.toISOString(), timeZone: "America/New_York" },
    },
  });
}

// ─────────────────────────────────────────────
// GOOGLE MAPS — verificar distancia
// ─────────────────────────────────────────────
async function getTravelMinutes(origin, destination) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  try {
    return Math.round(data.rows[0].elements[0].duration.value / 60);
  } catch {
    return 999;
  }
}

// ─────────────────────────────────────────────
// CEREBRO — analizar mensaje con Claude
// ─────────────────────────────────────────────
async function analyzeMessage(incomingMsg, appointments) {
  const apptSummary = appointments.length > 0
    ? appointments.map((a) => `- ${a.title} at ${a.start} at ${a.address}`).join("\n")
    : "No appointments scheduled yet today or tomorrow.";

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  const timeNow = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

  const prompt = `You are a friendly booking assistant for "${BUSINESS.name}", a mobile nail spa owned by ${BUSINESS.owner}.

TODAY: ${today}, ${timeNow} (Eastern Time)

BUSINESS RULES — follow these strictly:
1. Only book appointments for TODAY or TOMORROW (close dates only).
2. Working hours: Tue-Fri 9:30am-5pm, Sat 10am-5pm. CLOSED Sunday and Monday.
3. Max ${BUSINESS.maxAppointmentsPerDay} appointments per day.
4. Max ${BUSINESS.maxTravelMinutes} minutes travel between appointments same day.
5. Coverage area: ${BUSINESS.coverage.join(", ")}.
6. We do NOT do acrylic nails — natural nails ONLY. If asked for acrylics, politely decline and explain.
7. Always ask for the client's address if not provided.
8. If address is outside coverage or too far from other appointments, suggest a different day.
9. A travel fee applies to all services.
10. Detect the language of the message and respond in THAT SAME LANGUAGE.
11. Be warm, brief, and professional. Use occasional emoji 💅

SQUARESPACE FORM EMAILS — IMPORTANT:
Many messages arrive as form submissions from the website with this format:
  NAME: [client name]
  PHONE: [phone]
  EMAIL: [email]
  ADDRESS OF SERVICE: [full address]
  SERVICE DETAILS: [service requested]
When you detect this format, extract all fields automatically — do NOT ask for info already provided.
Reply directly to the client's email with availability and next steps.

SERVICES & PRICES:
${BUSINESS.services}

CURRENT APPOINTMENTS (today & tomorrow):
${apptSummary}

INCOMING MESSAGE:
"${incomingMsg}"

Respond ONLY with this JSON (no extra text, no backticks):
{
  "language": "en" or "es",
  "is_squarespace_form": true/false,
  "needs_address": true/false,
  "detected_address": "address or null",
  "client_phone": "phone from form or null",
  "client_email": "email from form or null",
  "appointment_requested": true/false,
  "acrylic_requested": true/false,
  "out_of_coverage": true/false,
  "client_name": "name or null",
  "service_requested": "service name or null",
  "service_duration_mins": number or 90,
  "proposed_datetime": "ISO 8601 or null",
  "zone_ok": true/false,
  "reply": "short friendly reply for SMS, call or email"
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ─────────────────────────────────────────────
// PROCESAR MENSAJE — lógica central
// ─────────────────────────────────────────────
async function processMessage(text, appointments) {
  const analysis = await analyzeMessage(text, appointments);

  // Verificar distancia si hay dirección y citas previas
  if (analysis.appointment_requested && !analysis.acrylic_requested && analysis.detected_address && appointments.length > 0) {
    const last = appointments[appointments.length - 1];
    if (last.address) {
      const mins = await getTravelMinutes(last.address, analysis.detected_address);
      analysis.zone_ok = mins <= BUSINESS.maxTravelMinutes;
      analysis.travel_mins = mins;
    }
  }

  // Agendar si todo está bien
  if (
    analysis.appointment_requested &&
    !analysis.acrylic_requested &&
    !analysis.out_of_coverage &&
    analysis.zone_ok !== false &&
    analysis.detected_address &&
    analysis.proposed_datetime &&
    analysis.client_name
  ) {
    await createAppointment(
      analysis.client_name,
      analysis.service_requested || "Nail Service",
      analysis.detected_address,
      analysis.proposed_datetime,
      analysis.service_duration_mins || 90
    );
    console.log(`✅ Cita agendada: ${analysis.client_name} — ${analysis.service_requested} — ${analysis.proposed_datetime}`);
  }

  return analysis;
}

// ─────────────────────────────────────────────
// YAHOO MAIL — IMAP directo con app password
// ─────────────────────────────────────────────
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

function getImapConnection() {
  return new Imap({
    user: process.env.YAHOO_EMAIL,
    password: process.env.YAHOO_APP_PASSWORD,
    host: "imap.mail.yahoo.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });
}

function getSmtpTransporter() {
  return nodemailer.createTransport({
    host: "smtp.mail.yahoo.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.YAHOO_EMAIL,
      pass: process.env.YAHOO_APP_PASSWORD,
    },
  });
}

async function getUnreadEmails() {
  return new Promise((resolve, reject) => {
    const imap = getImapConnection();
    const results = [];

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err, box) => {
        if (err) return reject(err);

        imap.search(["UNSEEN"], (err, uids) => {
          if (err) return reject(err);
          if (!uids || uids.length === 0) {
            imap.end();
            return resolve([]);
          }

          const fetch = imap.fetch(uids.slice(0, 5), { bodies: "", markSeen: true });

          fetch.on("message", (msg) => {
            let buffer = "";
            let uid;

            msg.on("attributes", (attrs) => { uid = attrs.uid; });
            msg.on("body", (stream) => {
              stream.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
              stream.once("end", async () => {
                const parsed = await simpleParser(buffer);
                results.push({
                  uid,
                  from: parsed.from?.text || "",
                  replyTo: parsed.replyTo?.text || parsed.from?.text || "",
                  subject: parsed.subject || "",
                  body: parsed.text || parsed.html || "",
                });
              });
            });
          });

          fetch.once("end", () => {
            setTimeout(() => { imap.end(); resolve(results); }, 1000);
          });
        });
      });
    });

    imap.once("error", reject);
    imap.connect();
  });
}

async function sendEmailReply(to, subject, replyText) {
  const transporter = getSmtpTransporter();
  await transporter.sendMail({
    from: `Pamper Me Mobile Nails <${process.env.YAHOO_EMAIL}>`,
    to,
    subject: `Re: ${subject}`,
    text: `${replyText}\n\n---\nPamper Me Mobile Nails & Spa\n📱 215-490-1515\n🌐 pampermemobilenails.com\n📸 @pamperme.mobile.nails`,
  });
}

// ─────────────────────────────────────────────
// WEBHOOK — SMS entrante (215-490-1515)
// ─────────────────────────────────────────────
app.post("/webhook/sms", async (req, res) => {
  const body = req.body.Body || "";
  const from = req.body.From || "";
  console.log(`💬 SMS de ${from}: ${body}`);

  try {
    const appointments = await getUpcomingAppointments();
    const analysis = await processMessage(body, appointments);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(analysis.reply);
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ SMS error:", err);
    res.status(500).send("Error");
  }
});

// ─────────────────────────────────────────────
// WEBHOOK — Llamada entrante (voz)
// ─────────────────────────────────────────────
app.post("/webhook/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/webhook/voice/process",
    method: "POST",
    language: "en-US",
    speechTimeout: "auto",
    hints: "appointment, nails, manicure, pedicure, gel, polish, wax, schedule, cita, uñas, manicura, pedicura, agendar",
  });

  gather.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Thank you for calling Pamper Me Mobile Nails and Spa! How can I help you today? " +
    "Gracias por llamar a Pamper Me. ¿En qué le puedo ayudar?"
  );

  res.type("text/xml").send(twiml.toString());
});

app.post("/webhook/voice/process", async (req, res) => {
  const speechResult = req.body.SpeechResult || "";
  const callerNumber = req.body.From || "";
  console.log(`📞 Llamada de ${callerNumber}: "${speechResult}"`);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const appointments = await getUpcomingAppointments();
    const analysis = await processMessage(speechResult, appointments);

    const voice = analysis.language === "es" ? "Polly.Conchita" : "Polly.Joanna";
    const lang = analysis.language === "es" ? "es-ES" : "en-US";

    twiml.say({ voice, language: lang }, analysis.reply);

    // SMS de confirmación si se agendó
    if (analysis.appointment_requested && analysis.zone_ok && analysis.proposed_datetime && !analysis.acrylic_requested) {
      const dt = new Date(analysis.proposed_datetime).toLocaleString(
        analysis.language === "es" ? "es-US" : "en-US",
        { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }
      );

      const confirmMsg = analysis.language === "es"
        ? `✅ Pamper Me: Cita confirmada!\n📅 ${dt}\n📍 ${analysis.detected_address}\n💅 ${analysis.service_requested || "Nail Service"}\n\nPreguntas: 215-490-1515`
        : `✅ Pamper Me: Appointment confirmed!\n📅 ${dt}\n📍 ${analysis.detected_address}\n💅 ${analysis.service_requested || "Nail Service"}\n\nQuestions: 215-490-1515`;

      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: callerNumber,
        body: confirmMsg,
      });
    }
  } catch (err) {
    console.error("❌ Voz error:", err);
    twiml.say(
      { voice: "Polly.Joanna" },
      "I'm sorry, I had a technical issue. Please text us at 215-490-1515 or visit pampermemobilenails.com to book."
    );
  }

  res.type("text/xml").send(twiml.toString());
});

// ─────────────────────────────────────────────
// TAREA AUTOMÁTICA — revisar Gmail cada 5 min
// ─────────────────────────────────────────────
async function checkYahooMail() {
  try {
    const emails = await getUnreadEmails();

    if (emails.length === 0) return;
    console.log(`📧 ${emails.length} correo(s) nuevo(s) en Yahoo`);

    const appointments = await getUpcomingAppointments();

    for (const email of emails) {
      const content = email.body || email.subject;
      const analysis = await processMessage(content, appointments);
      const replyTo = email.replyTo || email.from;
      await sendEmailReply(replyTo, email.subject, analysis.reply);
      console.log(`✉️ Respuesta enviada a ${replyTo}`);
    }
  } catch (err) {
    console.error("❌ Yahoo email error:", err);
  }
}

setInterval(checkYahooMail, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// SERVIDOR
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`
    <h2>💅 Pamper Me — Agente de Citas</h2>
    <p>Status: <strong>Active</strong></p>
    <p>Channels: Voice + SMS + Yahoo Mail (IMAP directo)</p>
    <p>Coverage: Montgomery, Bucks, Delaware, Chester, Philadelphia + NJ</p>
    <p>Hours: Tue-Fri 9:30am-5pm | Sat 10am-5pm</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Pamper Me Agent running on port ${PORT}`);
  console.log(`📧 Checking Yahoo Mail every 5 minutes...`);
  checkYahooMail();
});
