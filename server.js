const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');

const PORT = Number(process.env.PORT) || 3000;
const FILE = path.join(__dirname, 'numbers.json');

const BASE_URL = (
  process.env.BASE_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO || 'angierodca@gmail.com';

/*
  IMPORTANTE:
  Para pruebas puedes usar:
      onboarding@resend.dev

  Cuando tengas un dominio verificado en Resend,
  cambia RESEND_FROM en Render por tu dirección real.
*/
const RESEND_FROM =
  process.env.RESEND_FROM || 'onboarding@resend.dev';

const resend = RESEND_API_KEY
  ? new Resend(RESEND_API_KEY)
  : null;


/* =========================================================
   BASIC HELPERS
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
    'Content-Length': Buffer.byteLength(body)
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
   NUMBERS DATABASE
========================================================= */

function readNumbers() {
  try {
    if (!fs.existsSync(FILE)) {
      return [];
    }

    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);

    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('ERROR LEYENDO numbers.json:', e);
    return [];
  }
}


function writeNumbers(list) {
  const tmp = `${FILE}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(list, null, 2),
    'utf8'
  );

  fs.renameSync(tmp, FILE);
}


/*
  Un número se considera libre cuando:

  - está available

  O

  - está reservado temporalmente
  - todavía no tiene nombre
  - han pasado más de 15 minutos
*/
function free(n) {
  if (!n) return false;

  if (n.status === 'available') {
    return true;
  }

  if (
    n.status === 'reserved' &&
    !n.name &&
    Date.now() - Number(n.at || 0) > 15 * 60 * 1000
  ) {
    return true;
  }

  return false;
}


/* =========================================================
   DATABASE MUTATIONS
========================================================= */

function apply(list, action, payload) {
  const orderId = String(payload.orderId || '');

  if (!orderId) {
    throw error('Falta orderId.', 400);
  }


  /*
    RESERVE
  */
  if (action === 'reserve') {
    const map = new Map(
      list.map(n => [String(n.num), n])
    );

    const nums = Array.isArray(payload.nums)
      ? payload.nums.map(String)
      : [];

    if (!nums.length) {
      throw error('No se recibieron números.', 400);
    }

    for (const num of nums) {
      const n = map.get(num);

      if (!n || !free(n)) {
        throw error(
          `El número ${num} ya no está disponible.`,
          409
        );
      }
    }

    for (const num of nums) {
      const n = map.get(num);

      Object.assign(n, {
        status: 'reserved',
        name: '',
        phone: '',
        confirm: false,
        orderId,
        at: Date.now()
      });
    }
  }


  /*
    RELEASE
  */
  else if (action === 'release') {
    for (const n of list) {
      if (
        String(n.orderId || '') === orderId &&
        !n.name
      ) {
        Object.assign(n, {
          status: 'available',
          orderId: '',
          at: 0,
          name: '',
          phone: '',
          confirm: false
        });
      }
    }
  }


  /*
    SUBMIT
  */
  else if (action === 'submit') {
    let found = false;

    for (const n of list) {
      if (String(n.orderId || '') === orderId) {
        found = true;

        Object.assign(n, {
          status: 'reserved',
          name: String(payload.name || ''),
          phone: String(payload.phone || ''),
          confirm: false
        });
      }
    }

    if (!found) {
      throw error(
        'No se encontró la reserva.',
        404
      );
    }
  }


  /*
    APPROVE
  */
  else if (action === 'approve') {
    let found = false;

    for (const n of list) {
      if (String(n.orderId || '') === orderId) {
        found = true;

        Object.assign(n, {
          status: 'unavailable',
          confirm: true
        });
      }
    }

    if (!found) {
      throw error(
        'No se encontró la reserva.',
        404
      );
    }
  }


  else {
    throw error(
      `Acción desconocida: ${action}`,
      400
    );
  }

  return list;
}


/* =========================================================
   PUBLIC NUMBERS
========================================================= */

function publicNumbers(list) {
  return list.map(n => ({
    num: n.num,
    status: n.status
  }));
}


/* =========================================================
   REQUEST BODY - JSON
========================================================= */

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
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
        const raw = Buffer.concat(chunks).toString('utf8');

        if (!raw) {
          resolve({});
          return;
        }

        resolve(JSON.parse(raw));
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
   MULTIPART FORM PARSER
========================================================= */

function parseMultipart(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType =
      req.headers['content-type'] || '';

    const match = contentType.match(
      /boundary=(?:"([^"]+)"|([^;]+))/i
    );

    if (!match) {
      reject(error(
        'Falta boundary multipart.',
        400
      ));
      return;
    }

    const boundary =
      Buffer.from(`--${match[1] || match[2]}`);

    const chunks = [];
    let total = 0;

    req.on('data', chunk => {
      total += chunk.length;

      if (total > maxBytes) {
        reject(error(
          'El comprobante es demasiado grande.',
          413
        ));

        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const parts = [];

        let start = 0;

        while (true) {
          const index = body.indexOf(boundary, start);

          if (index === -1) {
            break;
          }

          if (index > start) {
            parts.push(
              body.slice(start, index)
            );
          }

          start =
            index +
            boundary.length;
        }

        const fields = {};
        let file = null;

        for (let part of parts) {
          if (!part.length) continue;

          if (
            part.subarray(0, 2).toString() === '\r\n'
          ) {
            part = part.subarray(2);
          }

          if (
            part.subarray(-2).toString() === '\r\n'
          ) {
            part = part.subarray(0, -2);
          }

          const separator =
            Buffer.from('\r\n\r\n');

          const split =
            part.indexOf(separator);

          if (split === -1) continue;

          const headerText =
            part
              .subarray(0, split)
              .toString('utf8');

          const content =
            part.subarray(
              split + separator.length
            );

          const disposition =
            headerText.match(
              /Content-Disposition:[^\r\n]+/i
            );

          if (!disposition) continue;

          const nameMatch =
            disposition[0].match(
              /name="([^"]+)"/i
            );

          if (!nameMatch) continue;

          const fieldName =
            nameMatch[1];

          const filenameMatch =
            disposition[0].match(
              /filename="([^"]*)"/i
            );

          /*
            FILE
          */
          if (filenameMatch && filenameMatch[1]) {
            const filename =
              path.basename(
                filenameMatch[1]
              );

            const contentTypeMatch =
              headerText.match(
                /Content-Type:\s*([^\r\n]+)/i
              );

            const mime =
              contentTypeMatch
                ? contentTypeMatch[1].trim()
                : 'application/octet-stream';

            file = {
              fieldName,
              filename,
              contentType: mime,
              buffer: content
            };
          }

          /*
            NORMAL FIELD
          */
          else {
            fields[fieldName] =
              content.toString('utf8');
          }
        }

        resolve({
          fields,
          file
        });

      } catch (e) {
        reject(error(
          'No se pudo procesar el formulario.',
          400
        ));
      }
    });

    req.on('error', reject);
  });
}


/* =========================================================
   EMAIL
========================================================= */

async function sendTestEmail() {
  if (!resend) {
    throw error(
      'RESEND_API_KEY no está configurada en Render.',
      500
    );
  }

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
          la conexión Render → Resend funciona.
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


async function sendOrderEmail({
  orderId,
  name,
  phone,
  numbers,
  file
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

  const safe = value =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');


  const email = {
    from: RESEND_FROM,

    to: [EMAIL_TO],

    subject:
      `Nueva reserva #${orderId}`,

    html: `
      <!DOCTYPE html>
      <html>
      <body style="
        font-family: Arial, sans-serif;
        line-height: 1.5;
        color: #222;
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
          <strong>Números pagados:</strong>
          ${safe(numbersText)}
        </p>

        <hr>

        <p>
          <strong>Estado:</strong>
          Pendiente de aprobación
        </p>

        <p>
          <a
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
          O puedes abrir directamente:
        </p>

        <p>
          ${safe(approveUrl)}
        </p>

      </body>
      </html>
    `
  };


  /*
    ATTACHMENT
  */
  if (file && file.buffer && file.buffer.length) {
    email.attachments = [
      {
        filename:
          file.filename || 'comprobante',
        content:
          file.buffer
      }
    ];
  }


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

const server = http.createServer(
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
         HEALTH CHECK
      ===================================================== */

      if (
        req.method === 'GET' &&
        pathname === '/api/health'
      ) {
        return json(res, 200, {
          ok: true,
          resendConfigured: !!RESEND_API_KEY,
          emailTo: EMAIL_TO
        });
      }


      /* =====================================================
         TEST RESEND
      ===================================================== */

      if (
        req.method === 'GET' &&
        pathname === '/api/test-email'
      ) {
        const data =
          await sendTestEmail();

        return json(res, 200, {
          ok: true,
          message:
            'Correo enviado por Resend.',
          data
        });
      }


      /* =====================================================
         GET NUMBERS
      ===================================================== */

      if (
        req.method === 'GET' &&
        pathname === '/api/numbers'
      ) {
        const list =
          readNumbers();

        return json(
          res,
          200,
          publicNumbers(list)
        );
      }


      /* =====================================================
         RESERVE / RELEASE
      ===================================================== */

      if (
        req.method === 'POST' &&
        pathname === '/api/numbers'
      ) {
        const body =
          await readJsonBody();

        const action =
          String(body.action || '');

        if (
          action !== 'reserve' &&
          action !== 'release'
        ) {
          throw error(
            'Acción inválida.',
            400
          );
        }

        const list =
          readNumbers();

        apply(
          list,
          action,
          body
        );

        writeNumbers(list);

        return json(
          res,
          200,
          publicNumbers(list)
        );
      }


      /* =====================================================
         PAY / SUBMIT
      ===================================================== */

      if (
        req.method === 'POST' &&
        pathname === '/api/pay'
      ) {

        /*
          NUEVO:
          Esperamos multipart/form-data.

          Campos:
            orderId
            name
            phone

          Archivo:
            Comprobante
        */

        const {
          fields,
          file
        } = await parseMultipart(req);


        const orderId =
          String(fields.orderId || '').trim();

        const name =
          String(fields.name || '').trim();

        const phone =
          String(fields.phone || '').trim();


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

        if (!file || !file.buffer.length) {
          throw error(
            'Falta el comprobante de pago.',
            400
          );
        }


        /*
          Solo permitimos imágenes como comprobante.
        */
        if (
          !/^image\//i.test(
            file.contentType
          )
        ) {
          throw error(
            'El comprobante debe ser una imagen.',
            400
          );
        }


        /*
          Máximo 10 MB para el comprobante.
        */
        if (
          file.buffer.length >
          10 * 1024 * 1024
        ) {
          throw error(
            'El comprobante supera el límite de 10 MB.',
            413
          );
        }


        /*
          Buscar la reserva antes de modificarla.
        */
        let list =
          readNumbers();

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
          Actualizar la reserva.
        */
        list =
          apply(
            list,
            'submit',
            {
              orderId,
              name,
              phone
            }
          );


        /*
          Guardamos primero el estado.
        */
        writeNumbers(list);


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
              file
            });

        } catch (mailError) {

          /*
            IMPORTANTE:

            Si el correo falla, devolvemos error.
            Los números ya quedaron reservados
            con nombre/teléfono.

            Esto permite ver el error real de Resend.
          */

          console.error(
            'FALLO EN ENVÍO DE CORREO:',
            mailError
          );

          return json(res, 502, {
            ok: false,
            stage: 'email',
            error:
              mailError.message ||
              String(mailError)
          });
        }


        return json(res, 200, {
          ok: true,
          message:
            'Reserva enviada correctamente.',
          orderId,
          numbers,
          emailId:
            emailData &&
            emailData.id
              ? emailData.id
              : null
        });
      }


      /* =====================================================
         APPROVE
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
            <body style="
              font-family:Arial;
              padding:40px;
            ">
              <h1>Error</h1>
              <p>Falta el ID del pedido.</p>
            </body>
            </html>
            `
          );
        }


        let list =
          readNumbers();


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
            <body style="
              font-family:Arial;
              padding:40px;
            ">
              <h1>Pedido no encontrado</h1>

              <p>
                El pedido
                <strong>${orderId}</strong>
                no existe.
              </p>
            </body>
            </html>
            `
          );
        }


        list =
          apply(
            list,
            'approve',
            { orderId }
          );


        writeNumbers(list);


        return html(
          res,
          200,
          `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport"
              content="width=device-width,initial-scale=1">
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

              <h1>Reserva aprobada</h1>

              <p>
                El pedido
                <strong>${orderId}</strong>
                ha sido aprobado.
              </p>

              <p>
                Los números asociados ahora están
                marcados como no disponibles.
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
            pathname.replace(/^\/+/, '')
          );
      }


      /*
        Evitar salir del directorio del proyecto.
      */
      const root =
        path.resolve(__dirname);

      const resolved =
        path.resolve(filePath);

      if (
        !resolved.startsWith(root)
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
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
      };


      const contentType =
        types[ext] ||
        'application/octet-stream';


      const data =
        fs.readFileSync(resolved);


      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.length
      });

      res.end(data);

    } catch (e) {

      console.error(
        'SERVER ERROR:',
        e
      );

      const status =
        Number(e.status) || 500;

      if (!res.headersSent) {
        json(res, status, {
          ok: false,
          error:
            e.message ||
            'Internal server error'
        });
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
  }
);
