// --- PROPRIETÀ GLOBALI ---
let PROPS;
let TELEGRAM_TOKEN;
let GEMINI_API_KEY;
let SHEET_ID;
let SHEET_TAB_NAME; // Nome del foglio log, es. "Log Attività"
let SPREADSHEET;

const LOG_SHEET_NAME = "Log Attività";
const GEMINI_MODEL = "gemini-2.5-flash";
const CACHE = CacheService.getScriptCache();

// --- FUNZIONE WEBHOOK (VELOCE) - SENZA TRY/CATCH ---

function doPost(e) {

  const update = JSON.parse(e.postData.contents);

  // 1. Controllo Idempotenza (Fondamentale)
  const update_id = update.update_id;
  if (update_id) {
    if (CACHE.get(String(update_id))) {
      return ContentService.createTextOutput(JSON.stringify({ "status": "ok_duplicate" })).setMimeType(ContentService.MimeType.JSON);
    }
    CACHE.put(String(update_id), 'processed', 600);
  }

  // 2. Gestisci solo messaggi vocali
  if (update.message && update.message.voice) {
    const chat_id = update.message.chat.id;
    const file_id = update.message.voice.file_id;

    try {
      loadScriptProperties();

      const lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) {
        sendTelegramMessage(chat_id, "Sono ancora al lavoro su un altro messaggio. Riprova tra qualche secondo.");
        return ContentService.createTextOutput(JSON.stringify({ "status": "busy" })).setMimeType(ContentService.MimeType.JSON);
      }

      try {
        const audioBlob = getTelegramFile(file_id);
        const jsonString = callGeminiForJson(audioBlob, "audio/ogg");

        if (!jsonString || jsonString.trim() === "") {
          throw new Error("Gemini ha restituito dati JSON vuoti.");
        }

        const rowsAdded = appendJsonToSheet(jsonString);
        const sheetUrl = SPREADSHEET.getUrl();

        if (rowsAdded > 0) {
          sendTelegramMessage(chat_id, `Fatto! Ho aggiunto ${rowsAdded} attività al tuo log.\nPuoi vederle qui: ${sheetUrl}`);
        } else {
          sendTelegramMessage(chat_id, `Ho elaborato il tuo messaggio ma non ho trovato attività da aggiungere.\nPuoi controllare qui: ${sheetUrl}`);
        }
      } catch (err) {
        Logger.log("ERRORE durante l'elaborazione immediata: " + err.message);

        if (err.message.includes("secondi") || err.message.includes("timeout") || err.message.includes("Execution timed out")) {
          sendTelegramMessage(chat_id, "Errore: l'analisi del tuo audio ha superato il tempo massimo. Prova con un vocale più corto.");
        } else if (err.message.includes("503") || err.message.includes("UNAVAILABLE") || err.message.includes("overloaded")) {
          sendTelegramMessage(chat_id, "ℹ️ Gemini è temporaneamente sovraccarico. Riprova tra qualche minuto.");
        } else {
          sendTelegramMessage(chat_id, `Si è verificato un errore durante l'analisi: ${err.message}`);
        }
      } finally {
        lock.releaseLock();
      }
    } catch (outerErr) {
      Logger.log("ERRORE GRAVE in doPost: " + outerErr.toString());
    }

  } else if (update.message && update.message.text) {
    // Rispondi ai messaggi di testo
    if(!TELEGRAM_TOKEN) loadScriptProperties();
    sendTelegramMessage(update.message.chat.id, "Non ho capito. Inviami solo messaggi vocali.");
  }

  // 4. Restituisci 200 OK a Telegram
  return ContentService.createTextOutput(JSON.stringify({ "status": "ok_processed" })).setMimeType(ContentService.MimeType.JSON);
}


// --- FUNZIONI HELPER (INVARIATE, LANCIANO GIÀ ERRORI) ---

function loadScriptProperties() {
  if (!PROPS) {
    PROPS = PropertiesService.getScriptProperties();
    TELEGRAM_TOKEN = PROPS.getProperty("TELEGRAM_TOKEN");
    GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY");
    SHEET_ID = PROPS.getProperty("SHEET_ID");
    SHEET_TAB_NAME = LOG_SHEET_NAME; 
    
    if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !SHEET_ID || !SHEET_TAB_NAME) {
        throw new Error("Una o più Proprietà Script (TOKEN, KEY, ID) non sono impostate.");
    }
    SPREADSHEET = SpreadsheetApp.openById(SHEET_ID);
    if (!SPREADSHEET) {
        throw new Error("Impossibile aprire Spreadsheet con ID: " + SHEET_ID);
    }
  }
}

function sendTelegramMessage(chat_id, text) {
  if (!TELEGRAM_TOKEN) loadScriptProperties();
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify({
      "chat_id": String(chat_id),
      "text": text,
      "parse_mode": "HTML"
    })
  };
  UrlFetchApp.fetch(url, { ...payload, muteHttpExceptions: false }); // Lancerà errore se fallisce
}

function getTelegramFile(file_id) {
  const getFileUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${file_id}`;
  const fileResponse = UrlFetchApp.fetch(getFileUrl, { "muteHttpExceptions": false });
  const fileData = JSON.parse(fileResponse.getContentText());
  if (!fileData.ok) {
      throw new Error("Errore API Telegram (getFile): " + fileData.description);
  }
  const file_path = fileData.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file_path}`;
  const audioBlob = UrlFetchApp.fetch(downloadUrl).getBlob();
  return audioBlob;
}

function callGeminiForJson(audioBlob, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const audioBase64 = Utilities.base64Encode(audioBlob.getBytes());
  const prompt = `
    Sei un assistente che analizza messaggi vocali e li trasforma in dati strutturati.
    Analizza l'audio allegato, che contiene una descrizione delle attività svolte da un utente.
    Estrai OGNI attività menzionata.
    
    Il tuo output DEVE essere ESCLUSIVAMENTE un blocco JSON valido.
    Non includere testo introduttivo, finale o i marcatori \`\`\`json.
    
    L'output deve essere un oggetto JSON con una singola chiave "attivita",
    che contiene un ARRAY di oggetti.
    
    Ogni oggetto nell'array deve avere ESATTAMENTE queste 6 chiavi:
    1. "nome": (stringa) Il titolo dell'attività.
    2. "azioni": (stringa) Descrizione di cosa è stato fatto.
    3. "luogo": (stringa) Se specificato, altrimenti stringa vuota "".
    4. "persone": (stringa) Se specificato, altrimenti stringa vuota "".
    5. "promemoria": (stringa) Estrai eventuali promemoria o follow-up. Altrimenti stringa vuota "".
    6. "tempo": (stringa) Stima la durata. Questa colonna è obbligatoria.

    Esempio di output perfetto:
    {
      "attivita": [
        {
          "nome": "Riunione Progetto X",
          "azioni": "Discussi i requisiti",
          "luogo": "Sala riunioni",
          "persone": "Mario Rossi",
          "promemoria": "Inviare verbale entro domani",
          "tempo": "1 ora"
        }
      ]
    }
  `;
  const payload = {
    "contents": [ { "parts": [ { "text": prompt }, { "inline_data": { "mime_type": mimeType, "data": audioBase64 } } ] } ],
    "generationConfig": { "temperature": 0.1, "maxOutputTokens": 2048 }
  };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": false 
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseText = response.getContentText();
  const jsonResponse = JSON.parse(responseText);
  
  if (!jsonResponse.candidates || !jsonResponse.candidates[0].content || !jsonResponse.candidates[0].content.parts[0].text) {
      throw new Error("Risposta da Gemini malformata o vuota. Response: " + responseText);
  }
  const jsonString = jsonResponse.candidates[0].content.parts[0].text
                      .replace(/```json/g, "").replace(/```/g, "").trim();
  return jsonString;
}

/**
 * Analizza la stringa JSON e la appende al Google Sheet. (V15.1)
 * Aggiunge automaticamente la data odierna come prima colonna.
 */
function appendJsonToSheet(jsonString) {
  const sheet = SPREADSHEET.getSheetByName(SHEET_TAB_NAME); 
  if (!sheet) {
      throw new Error(`Foglio log "${SHEET_TAB_NAME}" non trovato.`);
  }
  
  let data;
  try {
    // Manteniamo questo try-catch specifico per il JSON,
    // come nella V15, perché è un punto di errore noto.
    data = JSON.parse(jsonString);
  } catch (e) {
    throw new Error("Errore durante il parsing del JSON ricevuto da Gemini. Dati: " + jsonString);
  }
  
  if (!data.attivita || data.attivita.length === 0) {
    return 0; // Nessun dato da aggiungere
  }

  // --- MODIFICA 1 ---
  // Otteniamo la data di oggi, formattata
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  // --- FINE MODIFICA 1 ---

  // Le chiavi da estrarre dal JSON (l'ordine qui non è importante)
  const headers = ["nome", "azioni", "luogo", "persone", "promemoria", "tempo"];

  const values = data.attivita.map(row => {
    // Estrai i valori dal JSON
    const jsonValues = headers.map(header => {
      return row[header] || ""; 
    });
    
    // --- MODIFICA 2 ---
    // Aggiungi la data di oggi all'inizio dell'array della riga
    jsonValues.unshift(today);
    // --- FINE MODIFICA 2 ---
    
    return jsonValues;
  });

  // --- MODIFICA 3 ---
  // Ora scriviamo 7 colonne (1 per la data + 6 dai headers)
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length + 1)
       .setValues(values);
  // --- FINE MODIFICA 3 ---
       
  return values.length;
}
