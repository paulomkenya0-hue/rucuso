(function () {
  const FACULTIES = ["ICT", "FBMS", "FASS", "LAW", "IHAS", "HAS"];
  const STATUSES = ["active", "inactive", "graduated"];
  const HEADERS = ["full_name", "index_number", "phone", "faculty", "year_of_study", "status"];

  function parseCsv(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const records = [];
    const errors = [];
    let fields = [];
    let field = "";
    let quoted = false;
    let afterQuote = false;
    let line = 1;
    let recordLine = 1;
    let malformed = false;

    function finishField() {
      fields.push(field);
      field = "";
      afterQuote = false;
    }
    function finishRecord() {
      finishField();
      if (fields.some((value) => value.trim() !== "") || malformed) {
        records.push({ line: recordLine, fields, malformed });
      }
      fields = [];
      malformed = false;
      recordLine = line + 1;
    }

    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
          afterQuote = true;
        } else {
          field += char;
          if (char === "\n") line++;
          else if (char === "\r" && source[i + 1] !== "\n") line++;
        }
        continue;
      }

      if (char === "\r" || char === "\n") {
        if (char === "\r" && source[i + 1] === "\n") i++;
        finishRecord();
        line++;
        recordLine = line;
        continue;
      }
      if (char === ",") {
        finishField();
        continue;
      }
      if (char === '"') {
        if (field === "" && !afterQuote) quoted = true;
        else malformed = true;
        if (field !== "" || afterQuote) field += char;
        continue;
      }
      if (afterQuote && char.trim() !== "") malformed = true;
      field += char;
    }

    if (quoted) {
      malformed = true;
      errors.push({ line: recordLine, message: "Nukuu ya CSV haijafungwa." });
    }
    if (fields.length || field.length || malformed) finishRecord();

    if (!records.length) return { headers: [], rows: [], errors: [{ line: 1, message: "Faili haina data." }] };
    const headers = records.shift().fields.map((value) => value.trim().toLowerCase());
    const duplicates = headers.filter((value, index) => headers.indexOf(value) !== index);
    const missing = HEADERS.filter((header) => !headers.includes(header));
    if (duplicates.length) errors.push({ line: 1, message: "Majina ya safu yamejirudia: " + [...new Set(duplicates)].join(", ") });
    if (missing.length) errors.push({ line: 1, message: "Safu zinazokosekana: " + missing.join(", ") });

    const rows = records.map((record) => {
      const values = {};
      headers.forEach((header, index) => { values[header] = record.fields[index] ?? ""; });
      return { line: record.line, values, malformed: record.malformed || record.fields.length !== headers.length };
    });
    return { headers, rows, errors };
  }

  function normalizePhone(value) {
    let phone = String(value || "").trim().replace(/[\s()-]/g, "");
    if (/^0[678]\d{8}$/.test(phone)) phone = "+255" + phone.slice(1);
    else if (/^255[678]\d{8}$/.test(phone)) phone = "+" + phone;
    return /^\+255[678]\d{8}$/.test(phone) ? phone : null;
  }

  function validateCsv(text, existingRows, updateExisting) {
    const parsed = parseCsv(text);
    const valid = [];
    const invalid = parsed.rows.filter((row) => row.malformed).map((row) => ({
      line: row.line,
      message: "Muundo wa safu hauendani na vichwa au nukuu za CSV si sahihi.",
      values: row.values,
    }));
    const duplicates = [];
    const phoneWarnings = [];
    const existingByIndex = new Map((existingRows || []).map((row) => [
      String(row.index_number || "").trim().toUpperCase(), row,
    ]));
    const existingPhoneIndexes = new Map();
    (existingRows || []).forEach((row) => {
      const phone = normalizePhone(row.phone);
      const index = String(row.index_number || "").trim().toUpperCase();
      if (phone && index) {
        if (!existingPhoneIndexes.has(phone)) existingPhoneIndexes.set(phone, new Set());
        existingPhoneIndexes.get(phone).add(index);
      }
    });
    const seenIndex = new Set();
    const seenPhone = new Map();

    parsed.rows.filter((row) => !row.malformed).forEach((row) => {
      const input = row.values;
      const errors = [];
      const full_name = String(input.full_name || "").trim();
      const index_number = String(input.index_number || "").trim().toUpperCase();
      const phone = normalizePhone(input.phone);
      const faculty = String(input.faculty || "").trim().toUpperCase();
      const yearText = String(input.year_of_study || "").trim();
      const year_of_study = /^\d+$/.test(yearText) ? Number(yearText) : NaN;
      const status = String(input.status || "").trim().toLowerCase();

      if (!full_name) errors.push("Jina kamili linahitajika.");
      if (full_name.length > 160) errors.push("Jina kamili lisizidi herufi 160.");
      if (!index_number) errors.push("Namba ya usajili inahitajika.");
      if (index_number.length > 80) errors.push("Namba ya usajili ni ndefu mno.");
      if (!input.phone || !String(input.phone).trim()) errors.push("Namba ya simu inahitajika.");
      else if (!phone) errors.push("Namba ya simu si sahihi; tumia 06/07/08 au +255.");
      if (!FACULTIES.includes(faculty)) errors.push("Kitivo si sahihi.");
      if (!Number.isInteger(year_of_study) || year_of_study < 1 || year_of_study > 7) errors.push("Mwaka wa masomo uwe namba 1 hadi 7.");
      if (!STATUSES.includes(status)) errors.push("Hali iwe active, inactive au graduated.");

      if (errors.length) {
        invalid.push({ line: row.line, message: errors.join(" "), values: input });
        return;
      }
      if (seenIndex.has(index_number)) {
        duplicates.push({ line: row.line, message: "Namba ya usajili imejirudia ndani ya faili.", values: input, kind: "file" });
        return;
      }
      seenIndex.add(index_number);

      const existing = existingByIndex.get(index_number);
      if (existing && !updateExisting) {
        duplicates.push({ line: row.line, message: "Namba ya usajili tayari ipo; washa ruhusa ya kusasisha rekodi zilizopo.", values: input, kind: "existing", existing });
        return;
      }
      if (seenPhone.has(phone)) {
        phoneWarnings.push({ line: row.line, message: "Namba ya simu inatumiwa na rekodi nyingine ndani ya faili.", values: input });
      } else {
        seenPhone.set(phone, row.line);
      }
      const phoneIndexes = existingPhoneIndexes.get(phone);
      if (phoneIndexes && [...phoneIndexes].some((index) => index !== index_number)) {
        phoneWarnings.push({ line: row.line, message: "Namba ya simu tayari inahusishwa na namba nyingine kwenye mfumo.", values: input });
      }
      valid.push({
        operation: existing ? "update" : "insert",
        line: row.line,
        record: { full_name, index_number, phone, faculty, year_of_study, status },
      });
    });

    return {
      detected: parsed.rows.length,
      valid,
      invalid: [...parsed.errors.map((error) => ({ ...error, values: {} })), ...invalid],
      duplicates,
      phoneWarnings,
      headerErrors: parsed.errors.length > 0,
    };
  }

  window.HESLBImport = { FACULTIES, STATUSES, HEADERS, parseCsv, normalizePhone, validateCsv };
})();
