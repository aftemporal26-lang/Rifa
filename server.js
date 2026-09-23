const http = require('http');
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

const PORT = Number(process.env.PORT) || 3000;

const BASE_URL = (
  process.env.BASE_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_TO = process.env.EMAIL_TO || 'angierodca@gmail.com';
const RESEND_FROM =
  process.env.RESEND_FROM || 'onboarding@resend.dev';

const resend = RESEND_API_KEY
  ? new Resend(RESEND_API_KEY)
  : null;


/* =========================================================
   SUPABASE CONFIG (persistencia)

   Variables de entorno (Render):
     SUPABASE_URL          (obligatoria)
     SUPABASE_SECRET_KEY   (obligatoria)
     SUPABASE_TABLE        (opcional, por defecto "numbers")

   Columnas de la tabla:
     id, id_num, num, status, name, phone, confirm, date

   Mapeo hacia el formato que espera el frontend:
     num      -> num
     status   -> status
     name     -> name
     phone    -> phone
     confirm  -> confirm
     id_num   -> orderId
     date     -> at   (milisegundos, bigint)
========================================================= */

const SUPABASE_URL =
  (process.env.SUPABASE_URL || '').replace(/\/+$/, '');

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || '';

const SUPABASE_TABLE =
  process.env.SUPABASE_TABLE || 'numbers';

const SUPABASE_TIMEOUT_MS = 15000;

const RESERVATION_TTL_MS = 15 * 60 * 1000;


/* =========================================================
   HELPERS
========================================================= */

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });

  res.end(body);
}


function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });

  res.end(body);
}


function text(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });

  res.end(body);
}


function error(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}


/* =========================================================
   SUPABASE API

   Nunca se registra la clave en los logs.
========================================================= */

function supabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SECRET_KEY);
}


function assertSupabaseConfigured() {
  const missing = [];

  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SECRET_KEY) missing.push('SUPABASE_SECRET_KEY');

  if (missing.length) {
    console.error(
      'SUPABASE CONFIG ERROR: faltan variables de entorno:',
      missing.join(', ')
    );

    throw error(
      'Persistencia no configurada en el servidor.',
      500
    );
  }
}


/*
  Llamada genérica a la API REST de Supabase (PostgREST).
  Devuelve { status, data }.
*/

async function supabaseRequest(method, query, body, extraHeaders) {

  assertSupabaseConfigured();

  const url =
    `${SUPABASE_URL}/rest/v1/` +
    `${encodeURIComponent(SUPABASE_TABLE)}` +
    `${query ? `?${query}` : ''}`;

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    SUPABASE_TIMEOUT_MS
  );

  let response;

  try {

    response = await fetch(url, {
      method,
      headers: {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        ...(body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(extraHeaders || {})
      },
      body: body !== undefined
        ? JSON.stringify(body)
        : undefined,
      signal: controller.signal
    });

  } catch (e) {

    console.error(
      'SUPABASE API: no se pudo contactar con Supabase:',
      e.name === 'AbortError'
        ? 'timeout'
        : e.message
    );

    throw error(
      'No se pudo contactar con la base de datos. Intenta de nuevo.',
      503
    );

  } finally {

    clearTimeout(timer);
  }

  let data = null;

  const raw = await response.text();

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = raw;
    }
  }

  if (response.status === 401 || response.status === 403) {

    console.error(
      `SUPABASE AUTH ERROR (${response.status}): ` +
      `la clave es inválida o no tiene permisos.`,
      typeof data === 'object' && data
        ? (data.message || '')
        : ''
    );

    throw error(
      'Error de autenticación con la base de datos.',
      502
    );
  }

  if (response.status === 404) {

    console.error(
      `SUPABASE NOT FOUND (404): revisa SUPABASE_URL y que ` +
      `la tabla "${SUPABASE_TABLE}" exista.`
    );

    throw error(
      'No se encontró la tabla en la base de datos.',
      500
    );
  }

  if (!response.ok) {

    console.error(
      `SUPABASE API ERROR: HTTP ${response.status}`,
      typeof data === 'object' && data
        ? (data.message || JSON.stringify(data))
        : data
    );

    throw error(
      'Error en la base de datos.',
      502
    );
  }

  return {
    status: response.status,
    data
  };
}


/* =========================================================
   NUMBERS DATABASE (Supabase)
========================================================= */

/*
  Convierte una fila de Supabase al formato
  que ya usaba el resto del servidor y el frontend.
*/

function rowToNumber(row) {
  return {
    num: String(row.num),
    status: row.status,
    name: row.name || '',
    phone: row.phone || '',
    confirm: !!row.confirm,
    orderId: row.id_num ? String(row.id_num) : '',
    at: Number(row.date || 0)
  };
}


/*
  Lee todos los números, ordenados por id.
*/

async function readNumbers() {

  const { data } =
    await supabaseRequest(
      'GET',
      'select=id,id_num,num,status,name,phone,confirm,date' +
      '&order=id.asc'
    );

  if (!Array.isArray(data)) {

    console.error(
      'SUPABASE ERROR: la respuesta no es un arreglo.'
    );

    throw error(
      'Respuesta inválida de la base de datos.',
      502
    );
  }

  return data.map(rowToNumber);
}


/*
  Codifica un valor para usarlo en un filtro de PostgREST.
*/

function q(value) {
  return encodeURIComponent(String(value));
}


/*
  Aplica un PATCH y devuelve las filas realmente
  modificadas (return=representation).
*/

async function patchRows(filter, values) {

  const { data } =
    await supabaseRequest(
      'PATCH',
      filter,
      values,
      { 'Prefer': 'return=representation' }
    );

  return Array.isArray(data) ? data : [];
}


/* =========================================================
   AVAILABLE / EXPIRED RESERVATIONS
========================================================= */

function free(n) {
  if (!n) {
    return false;
  }

  if (n.status === 'available') {
    return true;
  }

  if (
    n.status === 'reserved' &&
    !n.name &&
    Number(n.at || 0) &&
    Date.now() - Number(n.at) > RESERVATION_TTL_MS
  ) {
    return true;
  }

  return false;
}


/* =========================================================
   PUBLIC DATABASE
========================================================= */

function publicNumbers(list) {
  return list.map(n => ({
    num: n.num,
    status: n.status,
    name: n.name || '',
    phone: n.phone || '',
    confirm: !!n.confirm,
    orderId: n.orderId || '',
    at: Number(n.at || 0)
  }));
}


/* =========================================================
   DATABASE MUTATIONS

   Cada acción se ejecuta directamente contra Supabase
   con UPDATEs condicionales, de modo que dos usuarios
   no puedan reservar el mismo número a la vez.
========================================================= */

/*
  RESERVE

  Para cada número se intenta un UPDATE condicional:
    - solo si sigue "available"
    - o si es una reserva expirada (reserved, sin nombre,
      con fecha anterior al límite)

  Si alguno falla, se revierten los ya reservados
  y se responde 409, igual que antes.
*/

async function reserveNumbers(payload) {

  const orderId = String(payload.orderId || '');

  if (!orderId) {
    throw error('Falta orderId.', 400);
  }

  const nums = Array.isArray(payload.nums)
    ? payload.nums.map(String)
    : [];

  if (!nums.length) {
    throw error('No se recibieron números.', 400);
  }

  const uniqueNums = [...new Set(nums)];

  const timestamp =
    Number(payload.at) || Date.now();

  const expiredBefore =
    Date.now() - RESERVATION_TTL_MS;


  /*
    Verificar que todos existan antes de tocar nada.
  */

  const { data: existing } =
    await supabaseRequest(
      'GET',
      `select=num&num=in.(${uniqueNums.map(q).join(',')})`
    );

  const existingSet =
    new Set(
      (Array.isArray(existing) ? existing : [])
        .map(r => String(r.num))
    );

  for (const num of uniqueNums) {
    if (!existingSet.has(num)) {
      throw error(
        `El número ${num} no existe.`,
        404
      );
    }
  }


  const reserved = [];

  const values = {
    status: 'reserved',
    name: '',
    phone: '',
    confirm: false,
    id_num: orderId,
    date: timestamp
  };


  try {

    for (const num of uniqueNums) {

      /*
        Intento 1: el número está disponible.
      */

      let rows =
        await patchRows(
          `num=eq.${q(num)}&status=eq.available`,
          values
        );

      /*
        Intento 2: reserva expirada (sin nombre y vieja).
      */

      if (!rows.length) {

        rows =
          await patchRows(
            `num=eq.${q(num)}` +
            `&status=eq.reserved` +
            `&name=eq.` +
            `&date=gt.0` +
            `&date=lt.${expiredBefore}`,
            values
          );
      }

      if (!rows.length) {

        throw error(
          `El número ${num} ya no está disponible.`,
          409
        );
      }

      reserved.push(num);
    }

  } catch (e) {

    /*
      Revertir los que sí alcanzamos a reservar.
    */

    for (const num of reserved) {
      try {
        await patchRows(
          `num=eq.${q(num)}&id_num=eq.${q(orderId)}&name=eq.`,
          {
            status: 'available',
            name: '',
            phone: '',
            confirm: false,
            id_num: null,
            date: 0
          }
        );
      } catch (rollbackError) {
        console.error(
          `ERROR REVIRTIENDO ${num}:`,
          rollbackError.message
        );
      }
    }

    throw e;
  }
}


/*
  RELEASE

  Libera los números del pedido que aún no tienen nombre.
*/

async function releaseNumbers(payload) {

  const orderId = String(payload.orderId || '');

  if (!orderId) {
    throw error('Falta orderId.', 400);
  }

  await patchRows(
    `id_num=eq.${q(orderId)}&name=eq.`,
    {
      status: 'available',
      name: '',
      phone: '',
      confirm: false,
      id_num: null,
      date: 0
    }
  );
}


/*
  SUBMIT

  Guarda nombre y teléfono en los números del pedido.
  Devuelve las filas afectadas.
*/

async function submitOrder(payload) {

  const orderId = String(payload.orderId || '');

  if (!orderId) {
    throw error('Falta orderId.', 400);
  }

  const rows =
    await patchRows(
      `id_num=eq.${q(orderId)}`,
      {
        status: 'reserved',
        name: String(payload.name || ''),
        phone: String(payload.phone || ''),
        confirm: false
      }
    );

  if (!rows.length) {
    throw error('No se encontró la reserva.', 404);
  }

  return rows;
}


/*
  APPROVE

  Marca los números del pedido como "unavailable".
  Devuelve las filas afectadas.
*/

async function approveOrder(payload) {

  const orderId = String(payload.orderId || '');

  if (!orderId) {
    throw error('Falta orderId.', 400);
  }

  const rows =
    await patchRows(
      `id_num=eq.${q(orderId)}`,
      {
        status: 'unavailable',
        confirm: true
      }
    );

  if (!rows.length) {
    throw error('No se encontró la reserva.', 404);
  }

  return rows;
}


/* =========================================================
   JSON BODY
========================================================= */

function readJsonBody(
  req,
  maxBytes = 15 * 1024 * 1024
) {
  return new Promise((resolve, reject) => {

    let total = 0;
    const chunks = [];

    req.on('data', chunk => {

      total += chunk.length;

      if (total > maxBytes) {
        reject(error(
          'Request demasiado grande.',
          413
        ));

        req.destroy();
        return;
      }

      chunks.push(chunk);
    });


    req.on('end', () => {

      try {
        const raw =
          Buffer.concat(chunks)
            .toString('utf8');

        if (!raw) {
          resolve({});
          return;
        }

        resolve(
          JSON.parse(raw)
        );

      } catch (e) {

        reject(error(
          'JSON inválido.',
          400
        ));
      }
    });


    req.on('error', reject);
  });
}


/* =========================================================
   MULTIPART/FORM-DATA BODY

   El index.html envía el comprobante con FormData
   (multipart/form-data), no con JSON. Este parser mínimo
   lee los campos de texto y el archivo sin dependencias
   externas.
========================================================= */

function readMultipartBody(
  req,
  maxBytes = 15 * 1024 * 1024
) {
  return new Promise((resolve, reject) => {

    const contentType =
      req.headers['content-type'] || '';

    const boundaryMatch =
      contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

    if (!boundaryMatch) {
      reject(error(
        'Content-Type multipart inválido.',
        400
      ));
      return;
    }

    const boundary =
      '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();

    let total = 0;
    const chunks = [];

    req.on('data', chunk => {

      total += chunk.length;

      if (total > maxBytes) {
        reject(error(
          'Request demasiado grande.',
          413
        ));

        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {

      try {

        const buffer =
          Buffer.concat(chunks);

        const boundaryBuf =
          Buffer.from(`\r\n${boundary}`, 'utf8');

        const firstBoundaryBuf =
          Buffer.from(boundary, 'utf8');

        const fields = {};
        const files = {};

        let start =
          buffer.indexOf(firstBoundaryBuf) +
          firstBoundaryBuf.length;

        while (true) {

          const nextBoundaryIndex =
            buffer.indexOf(boundaryBuf, start);

          if (nextBoundaryIndex === -1) {
            break;
          }

          const part =
            buffer.slice(start, nextBoundaryIndex);

          const headerEndIndex =
            part.indexOf('\r\n\r\n');

          if (headerEndIndex !== -1) {

            const rawHeaders =
              part
                .slice(0, headerEndIndex)
                .toString('utf8');

            const content =
              part.slice(headerEndIndex + 4);

            const nameMatch =
              rawHeaders.match(
                /name="([^"]*)"/i
              );

            const filenameMatch =
              rawHeaders.match(
                /filename="([^"]*)"/i
              );

            const typeMatch =
              rawHeaders.match(
                /Content-Type:\s*([^\r\n]+)/i
              );

            const fieldName =
              nameMatch ? nameMatch[1] : '';

            if (fieldName) {

              if (filenameMatch) {

                files[fieldName] = {
                  filename: filenameMatch[1] || '',
                  contentType:
                    typeMatch
                      ? typeMatch[1].trim()
                      : 'application/octet-stream',
                  data: content
                };

              } else {

                fields[fieldName] =
                  content.toString('utf8');
              }
            }
          }

          start =
            nextBoundaryIndex + boundaryBuf.length;

          const tail =
            buffer.slice(start, start + 2).toString('utf8');

          if (tail === '--') {
            break;
          }
        }

        resolve({ fields, files });

      } catch (e) {

        reject(error(
          'No se pudo leer el formulario.',
          400
        ));
      }
    });
  });
}


/* =========================================================
   RESEND - TEST
========================================================= */

async function sendTestEmail() {

  if (!resend) {
    throw error(
      'RESEND_API_KEY no está configurada en Render.',
      500
    );
  }

  console.log(
    'Enviando correo de prueba con Resend...'
  );

  const result =
    await resend.emails.send({
      from: RESEND_FROM,
      to: [EMAIL_TO],
      subject: 'TEST RIFA - Resend',
      html: `
        <h1>TEST RIFA</h1>

        <p>
          Este correo fue enviado desde
          <strong>Render</strong>
          utilizando
          <strong>Resend</strong>.
        </p>

        <p>
          Si recibes este mensaje,
          Render → Resend funciona correctamente.
        </p>
      `
    });

  if (result.error) {

    console.error(
      'RESEND TEST ERROR:',
      result.error
    );

    throw error(
      result.error.message ||
      'Resend rechazó el correo.',
      502
    );
  }

  console.log(
    'RESEND TEST SUCCESS:',
    result.data
  );

  return result.data;
}


/* =========================================================
   RESEND - ORDER EMAIL
========================================================= */

async function sendOrderEmail({
  orderId,
  name,
  phone,
  numbers,
  receiptBase64,
  receiptType,
  receiptName
}) {

  if (!resend) {
    throw error(
      'RESEND_API_KEY no está configurada en Render.',
      500
    );
  }


  const approveUrl =
    `${BASE_URL}/api/approve?order=${encodeURIComponent(orderId)}`;


  const numbersText =
    numbers.join(', ');


  function safe(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }


  const email = {

    from: RESEND_FROM,

    to: [EMAIL_TO],

    subject:
      `Nueva reserva #${orderId}`,

    html: `
      <!DOCTYPE html>

      <html>
      <body style="
        font-family:Arial,sans-serif;
        line-height:1.5;
        color:#222;
      ">

        <h2>Nueva reserva</h2>

        <p>
          Se recibió una nueva solicitud de pago.
        </p>

        <hr>

        <p>
          <strong>Pedido:</strong>
          ${safe(orderId)}
        </p>

        <p>
          <strong>Nombre:</strong>
          ${safe(name)}
        </p>

        <p>
          <strong>Teléfono:</strong>
          ${safe(phone)}
        </p>

        <p>
          <strong>Números:</strong>
          ${safe(numbersText)}
        </p>

        <hr>

        <p>
          <strong>Estado:</strong>
          Pendiente de aprobación
        </p>

        <p>
          
            href="${approveUrl}"
            style="
              display:inline-block;
              padding:12px 18px;
              background:#111;
              color:#fff;
              text-decoration:none;
              border-radius:6px;
            "
          >
            APROBAR RESERVA
          </a>
        </p>

        <p>
          Si el botón no funciona, abre:
        </p>

        <p>
          ${safe(approveUrl)}
        </p>

      </body>
      </html>
    `
  };


  /*
    COMPROBANTE
  */

  if (
    receiptBase64 &&
    typeof receiptBase64 === 'string'
  ) {

    const cleanBase64 =
      receiptBase64.includes(',')
        ? receiptBase64.split(',').pop()
        : receiptBase64;

    const buffer =
      Buffer.from(
        cleanBase64,
        'base64'
      );

    if (buffer.length) {

      email.attachments = [
        {
          filename:
            receiptName ||
            'comprobante.jpg',

          content:
            buffer
        }
      ];

      /*
        Resend necesita que el MIME
        del archivo sea reconocible.
      */
      if (receiptType) {
        email.attachments[0].contentType =
          receiptType;
      }
    }
  }


  console.log(
    'Enviando reserva a Resend:',
    {
      orderId,
      emailTo: EMAIL_TO,
      from: RESEND_FROM,
      numbers
    }
  );


  const result =
    await resend.emails.send(email);


  if (result.error) {

    console.error(
      'RESEND ORDER ERROR:',
      result.error
    );

    throw error(
      result.error.message ||
      'Resend rechazó el correo.',
      502
    );
  }


  console.log(
    'RESEND ORDER SUCCESS:',
    result.data
  );


  return result.data;
}


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || 'localhost'}`
          );

        const pathname =
          url.pathname;


        /* =====================================================
           HEALTH
        ===================================================== */

        if (
          req.method === 'GET' &&
          pathname === '/api/health'
        ) {

          return json(
            res,
            200,
            {
              ok: true,
              storage: 'supabase',
              supabaseConfigured:
                supabaseConfigured(),
              supabaseUrl: SUPABASE_URL,
              supabaseTable: SUPABASE_TABLE,
              resendConfigured:
                !!RESEND_API_KEY,
              emailTo: EMAIL_TO,
              resendFrom: RESEND_FROM,
              baseUrl: BASE_URL
            }
          );
        }


        /* =====================================================
           TEST EMAIL
        ===================================================== */

        if (
          req.method === 'GET' &&
          pathname === '/api/test-email'
        ) {

          const data =
            await sendTestEmail();

          return json(
            res,
            200,
            {
              ok: true,
              message:
                'Correo enviado por Resend.',
              data
            }
          );
        }


        /* =====================================================
           GET NUMBERS
        ===================================================== */

        if (
          req.method === 'GET' &&
          pathname === '/api/numbers'
        ) {

          const list =
            await readNumbers();

          return json(
            res,
            200,
            publicNumbers(list)
          );
        }


        /* =====================================================
           POST NUMBERS
           reserve / release / approve
        ===================================================== */

        if (
          req.method === 'POST' &&
          pathname === '/api/numbers'
        ) {

          const body =
            await readJsonBody(req);

          const action =
            String(body.action || '');


          if (
            action !== 'reserve' &&
            action !== 'release' &&
            action !== 'approve'
          ) {

            throw error(
              'Acción inválida.',
              400
            );
          }


          if (action === 'reserve') {
            await reserveNumbers(body);
          }

          else if (action === 'release') {
            await releaseNumbers(body);
          }

          else if (action === 'approve') {
            await approveOrder(body);
          }


          /*
            MUY IMPORTANTE:
            devolvemos DIRECTAMENTE el arreglo,
            porque el index.html original espera
            r.json() === arreglo de números.
          */

          const list =
            await readNumbers();

          return json(
            res,
            200,
            publicNumbers(list)
          );
        }


        /* =====================================================
           PAY
        ===================================================== */

        if (
          req.method === 'POST' &&
          pathname === '/api/pay'
        ) {

          /*
            El index.html envía multipart/form-data
            (FormData del navegador) con los campos:

              orderId
              name
              phone
              Comprobante  (archivo)
          */

          const contentType =
            req.headers['content-type'] || '';

          if (
            !/multipart\/form-data/i.test(contentType)
          ) {
            throw error(
              'Se esperaba multipart/form-data.',
              400
            );
          }

          const { fields, files } =
            await readMultipartBody(req);


          const orderId =
            String(fields.orderId || '')
              .trim();

          const name =
            String(fields.name || '')
              .trim();

          const phone =
            String(fields.phone || '')
              .trim();

          const receiptFile =
            files.Comprobante || null;


          if (!orderId) {
            throw error(
              'Falta el número de pedido.',
              400
            );
          }


          if (!name) {
            throw error(
              'Falta el nombre.',
              400
            );
          }


          if (!phone) {
            throw error(
              'Falta el teléfono.',
              400
            );
          }


          if (
            !receiptFile ||
            !receiptFile.data ||
            !receiptFile.data.length
          ) {
            throw error(
              'Falta el comprobante de pago.',
              400
            );
          }


          const receiptBuffer =
            receiptFile.data;

          const receiptType =
            receiptFile.contentType ||
            'image/jpeg';

          const receiptBase64 =
            receiptBuffer.toString('base64');


          /*
            Máximo 10 MB.
          */

          if (
            receiptBuffer.length >
            10 * 1024 * 1024
          ) {
            throw error(
              'El comprobante supera el límite de 10 MB.',
              413
            );
          }


          /*
            Buscar la reserva.
          */

          let list =
            await readNumbers();


          const reserved =
            list.filter(
              n =>
                String(n.orderId || '') ===
                orderId
            );


          if (!reserved.length) {
            throw error(
              'La reserva no existe o ya expiró.',
              404
            );
          }


          const numbers =
            reserved.map(
              n => String(n.num)
            );


          /*
            Guardar nombre y teléfono
            antes de enviar el correo.
          */

          await submitOrder({
            orderId,
            name,
            phone
          });


          list =
            await readNumbers();


          /*
            Enviar correo.
          */

          let emailData;

          try {

            emailData =
              await sendOrderEmail({
                orderId,
                name,
                phone,
                numbers,
                receiptBase64,
                receiptType,
                receiptName:
                  receiptFile.filename ||
                  `comprobante-${orderId}.jpg`
              });

          } catch (mailError) {

            console.error(
              'FALLO EN ENVÍO DE CORREO:',
              mailError
            );


            return json(
              res,
              502,
              {
                ok: false,
                stage: 'email',
                error:
                  mailError.message ||
                  String(mailError)
              }
            );
          }


          /*
            Respuesta idéntica a la original.
          */

          return json(
            res,
            200,
            {
              ok: true,
              orderId,
              numbers: list.map(n => ({
                num: n.num,
                status: n.status,
                name: n.name || '',
                phone: n.phone || '',
                confirm: !!n.confirm,
                orderId: n.orderId || '',
                at: Number(n.at || 0)
              }))
            }
          );
        }


        /* =====================================================
           GET APPROVE
        ===================================================== */

        if (
          req.method === 'GET' &&
          pathname === '/api/approve'
        ) {

          const orderId =
            String(
              url.searchParams.get('order') ||
              ''
            ).trim();


          if (!orderId) {

            return html(
              res,
              400,
              `
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <title>Error</title>
              </head>

              <body style="
                font-family:Arial,sans-serif;
                padding:40px;
              ">

                <h1>Error</h1>

                <p>
                  Falta el ID del pedido.
                </p>

              </body>
              </html>
              `
            );
          }


          const list =
            await readNumbers();


          const found =
            list.some(
              n =>
                String(n.orderId || '') ===
                orderId
            );


          if (!found) {

            return html(
              res,
              404,
              `
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <title>Pedido no encontrado</title>
              </head>

              <body style="
                font-family:Arial,sans-serif;
                padding:40px;
              ">

                <h1>Pedido no encontrado</h1>

                <p>
                  El pedido
                  <strong>${orderId}</strong>
                  no existe o ya no está disponible.
                </p>

              </body>
              </html>
              `
            );
          }


          await approveOrder({ orderId });


          return html(
            res,
            200,
            `
            <!DOCTYPE html>

            <html>

            <head>

              <meta charset="utf-8">

              <meta
                name="viewport"
                content="width=device-width,initial-scale=1"
              >

              <title>Reserva aprobada</title>

            </head>


            <body style="
              margin:0;
              background:#f5f5f5;
              font-family:Arial,sans-serif;
            ">

              <div style="
                max-width:600px;
                margin:80px auto;
                background:#fff;
                padding:40px;
                border-radius:12px;
                box-shadow:0 5px 30px rgba(0,0,0,.08);
              ">

                <h1>
                  Reserva aprobada
                </h1>

                <p>
                  El pedido
                  <strong>${orderId}</strong>
                  ha sido aprobado.
                </p>

                <p>
                  Los números asociados ahora
                  están marcados como pagados.
                </p>

              </div>

            </body>

            </html>
            `
          );
        }


        /* =====================================================
           STATIC FILES
        ===================================================== */

        let filePath;


        if (pathname === '/') {

          filePath =
            path.join(
              __dirname,
              'index.html'
            );

        }

        else if (
          pathname === '/index.html'
        ) {

          filePath =
            path.join(
              __dirname,
              'index.html'
            );

        }

        else if (
          pathname === '/qr.jpg'
        ) {

          filePath =
            path.join(
              __dirname,
              'qr.jpg'
            );

        }

        else if (
          pathname === '/qr.png'
        ) {

          filePath =
            path.join(
              __dirname,
              'qr.png'
            );

        }

        else {

          filePath =
            path.join(
              __dirname,
              pathname.replace(
                /^\/+/,
                ''
              )
            );
        }


        /*
          Seguridad:
          impedir salir de la carpeta
          del proyecto mediante ../
        */

        const root =
          path.resolve(__dirname);

        const resolved =
          path.resolve(filePath);


        if (
          resolved !== root &&
          !resolved.startsWith(root + path.sep)
        ) {

          return text(
            res,
            403,
            'Forbidden'
          );
        }


        if (
          !fs.existsSync(resolved) ||
          !fs.statSync(resolved).isFile()
        ) {

          return text(
            res,
            404,
            'Not found'
          );
        }


        const ext =
          path.extname(resolved)
            .toLowerCase();


        const types = {

          '.html':
            'text/html; charset=utf-8',

          '.css':
            'text/css; charset=utf-8',

          '.js':
            'application/javascript; charset=utf-8',

          '.json':
            'application/json; charset=utf-8',

          '.jpg':
            'image/jpeg',

          '.jpeg':
            'image/jpeg',

          '.png':
            'image/png',

          '.webp':
            'image/webp',

          '.svg':
            'image/svg+xml'
        };


        const contentType =
          types[ext] ||
          'application/octet-stream';


        const data =
          fs.readFileSync(resolved);


        res.writeHead(
          200,
          {
            'Content-Type':
              contentType,

            'Content-Length':
              data.length
          }
        );


        res.end(data);

      } catch (e) {

        console.error(
          'SERVER ERROR:',
          e.message || e
        );


        const status =
          Number(e.status) || 500;


        if (!res.headersSent) {

          json(
            res,
            status,
            {
              ok: false,
              error:
                e.message ||
                'Internal server error'
            }
          );

        } else {

          res.end();
        }
      }
    }
  );


/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `BASE_URL: ${BASE_URL}`
    );

    console.log(
      `EMAIL_TO: ${EMAIL_TO}`
    );

    console.log(
      `RESEND_FROM: ${RESEND_FROM}`
    );

    console.log(
      `RESEND_API_KEY: ${
        RESEND_API_KEY
          ? 'CONFIGURED'
          : 'MISSING'
      }`
    );

    console.log(
      `STORAGE: Supabase (${
        supabaseConfigured()
          ? `${SUPABASE_URL} / tabla ${SUPABASE_TABLE}`
          : 'NO CONFIGURADO - faltan variables SUPABASE_*'
      })`
    );

    console.log(
      `SUPABASE_SECRET_KEY: ${
        SUPABASE_SECRET_KEY
          ? 'CONFIGURED'
          : 'MISSING'
      }`
    );
  }
);
