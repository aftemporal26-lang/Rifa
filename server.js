const http = require('http');
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

const PORT = Number(process.env.PORT) || 3000;
const FILE = path.join(__dirname, 'numbers.json');

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
   NUMBERS DATABASE
========================================================= */

function readNumbers() {
  try {
    if (!fs.existsSync(FILE)) {
      throw error(
        'numbers.json no existe en el servidor.',
        500
      );
    }

    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw error(
        'numbers.json no contiene un arreglo válido.',
        500
      );
    }

    return data;

  } catch (e) {
    console.error('ERROR LEYENDO numbers.json:', e);

    if (e.status) {
      throw e;
    }

    throw error(
      'No se pudo leer numbers.json.',
      500
    );
  }
}


function writeNumbers(list) {
  try {
    const tmp = `${FILE}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(list, null, 2),
      'utf8'
    );

    fs.renameSync(tmp, FILE);

  } catch (e) {
    console.error('ERROR ESCRIBIENDO numbers.json:', e);

    throw error(
      `No se pudo guardar numbers.json: ${e.message}`,
      500
    );
  }
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
    Date.now() - Number(n.at) > 15 * 60 * 1000
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
========================================================= */

function apply(list, action, payload) {
  const orderId = String(payload.orderId || '');

  if (!orderId) {
    throw error(
      'Falta orderId.',
      400
    );
  }


  /* -------------------------------------------------------
     RESERVE
  ------------------------------------------------------- */

  if (action === 'reserve') {
    const map = new Map(
      list.map(n => [
        String(n.num),
        n
      ])
    );

    const nums = Array.isArray(payload.nums)
      ? payload.nums.map(String)
      : [];

    if (!nums.length) {
      throw error(
        'No se recibieron números.',
        400
      );
    }

    /*
      Elimina duplicados por seguridad.
    */
    const uniqueNums = [
      ...new Set(nums)
    ];

    /*
      Primero verificamos TODOS.
      No modificamos nada hasta saber
      que todos están disponibles.
    */
    for (const num of uniqueNums) {
      const n = map.get(num);

      if (!n) {
        throw error(
          `El número ${num} no existe.`,
          404
        );
      }

      if (!free(n)) {
        throw error(
          `El número ${num} ya no está disponible.`,
          409
        );
      }
    }

    /*
      Ahora sí reservamos.
    */
    const timestamp =
      Number(payload.at) || Date.now();

    for (const num of uniqueNums) {
      const n = map.get(num);

      Object.assign(n, {
        status: 'reserved',
        name: '',
        phone: '',
        confirm: false,
        orderId,
        at: timestamp
      });
    }
  }


  /* -------------------------------------------------------
     RELEASE
  ------------------------------------------------------- */

  else if (action === 'release') {

    for (const n of list) {
      if (
        String(n.orderId || '') === orderId &&
        !n.name
      ) {
        Object.assign(n, {
          status: 'available',
          name: '',
          phone: '',
          confirm: false,
          orderId: '',
          at: 0
        });
      }
    }
  }


  /* -------------------------------------------------------
     SUBMIT
  ------------------------------------------------------- */

  else if (action === 'submit') {

    let found = false;

    for (const n of list) {
      if (
        String(n.orderId || '') === orderId
      ) {
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


  /* -------------------------------------------------------
     APPROVE
  ------------------------------------------------------- */

  else if (action === 'approve') {

    let found = false;

    for (const n of list) {
      if (
        String(n.orderId || '') === orderId
      ) {
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
              numbersFile: fs.existsSync(FILE),
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
            readNumbers();

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
            await readJsonBody();

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


          const list =
            readNumbers();


          apply(
            list,
            action,
            body
          );


          writeNumbers(list);


          /*
            MUY IMPORTANTE:
            devolvemos DIRECTAMENTE el arreglo,
            porque el index.html original espera
            r.json() === arreglo de números.
          */

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
            El index.html original manda JSON:

            {
              orderId,
              name,
              phone,
              receipt: "BASE64..."
            }
          */

          const body =
            await readJsonBody();


          const orderId =
            String(body.orderId || '')
              .trim();

          const name =
            String(body.name || '')
              .trim();

          const phone =
            String(body.phone || '')
              .trim();

          const receipt =
            typeof body.receipt === 'string'
              ? body.receipt
              : '';


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


          if (!receipt) {
            throw error(
              'Falta el comprobante de pago.',
              400
            );
          }


          /*
            El frontend convierte el comprobante
            a JPEG usando canvas, por lo que normalmente
            llegará como base64 puro.
          */

          let receiptType =
            'image/jpeg';


          let receiptBase64 =
            receipt;


          /*
            También aceptamos Data URLs por seguridad.
          */

          const dataUrlMatch =
            receipt.match(
              /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
            );


          if (dataUrlMatch) {
            receiptType =
              dataUrlMatch[1];

            receiptBase64 =
              dataUrlMatch[2];
          }


          let receiptBuffer;

          try {

            receiptBuffer =
              Buffer.from(
                receiptBase64,
                'base64'
              );

          } catch (e) {

            throw error(
              'El comprobante no es válido.',
              400
            );
          }


          if (
            !receiptBuffer.length
          ) {
            throw error(
              'El comprobante está vacío.',
              400
            );
          }


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
            Guardar nombre y teléfono
            antes de enviar el correo.
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
                receiptBase64,
                receiptType,
                receiptName:
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
            Devolvemos DIRECTAMENTE el arreglo
            porque el index.html original hace:

              DB = j;

            y espera que j sea el arreglo.
          */

          return json(
            res,
            200,
            list.map(n => ({
              num: n.num,
              status: n.status,
              name: n.name || '',
              phone: n.phone || '',
              confirm: !!n.confirm,
              orderId: n.orderId || '',
              at: Number(n.at || 0)
            }))
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


          const approved =
            apply(
              list,
              'approve',
              { orderId }
            );


          writeNumbers(approved);


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
          e
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
      `numbers.json: ${
        fs.existsSync(FILE)
          ? 'FOUND'
          : 'MISSING'
      }`
    );
  }
);
