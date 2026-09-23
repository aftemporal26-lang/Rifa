// ==========================================
// CONFIGURACIÓN GLOBAL - COMPROBADA
// ==========================================
const FORMSPREE_URL = "https://formspree.io";
const RENDER_BACKEND = "https://onrender.com";

// Variables globales para el flujo (asegúrate de que tu lógica use estas o adáptalas)
let misNumerosSeleccionados = []; // Aquí deben guardarse los números que elige el usuario (ej:)
let miOrderIdTemporal = "ORD-" + Math.random().toString(36).substr(2, 9).toUpperCase();

// CAPTURA DEL FORMULARIO
const elFormulario = document.getElementById('form');

if (!elFormulario) {
    console.error("ALERTA: No se encontró ningún formulario con el ID 'form' en el HTML.");
} else {
    elFormulario.addEventListener('submit', async function(event) {
        event.preventDefault(); // Evitamos que la página se recargue locamente
        console.log("Formulario enviado. Iniciando proceso...");

        // 1. Captura manual y ultra-segura de los campos
        const inputNombre = document.querySelector('input[type="text"]') || document.getElementById('nombre');
        const inputTelefono = document.querySelector('input[type="tel"]') || document.getElementById('telefono');
        const inputFoto = document.querySelector('input[type="file"]') || document.getElementById('fotoComprobante');

        const nombre = inputNombre ? inputNombre.value.trim() : '';
        const telefono = inputTelefono ? inputTelefono.value.trim() : '';

        // 2. Validación estricta en el cliente
        if (!nombre || !telefono || !inputFoto || inputFoto.files.length === 0) {
            alert("⚠️ Por favor rellena todos los campos: Nombre, Teléfono y sube la foto del Comprobante.");
            return;
        }

        const archivoFoto = inputFoto.files[0];
        console.log("Campos validados correctamente. Archivo detectado:", archivoFoto.name);

        // Si por alguna razón tu grid no guardó números, ponemos uno de prueba para que no se trabe
        const numerosTexto = misNumerosSeleccionados.length > 0 ? misNumerosSeleccionados.join(', ') : 'Números en proceso';

        // 3. Crear el enlace de aprobación remota para tu Gmail
        const enlaceAprobar = `${RENDER_BACKEND}/api/approve?order=${encodeURIComponent(miOrderIdTemporal)}`;

        // 4. Empaquetar todo en FormData (Formato que Formspree exige para procesar archivos)
        const datosParaCorreo = new FormData();
        datosParaCorreo.append("Nombre Cliente", nombre);
        datosParaCorreo.append("Teléfono", telefono);
        datosParaCorreo.append("Números Comprados", numerosTexto);
        datosParaCorreo.append("Comprobante_Adjunto", archivoFoto); 
        datosParaCorreo.append("Acción Requerida", "Haz clic en el enlace de abajo para pasar los números a ocupados permanentemente:");
        datosParaCorreo.append("ENLACE DE APROBACIÓN", enlaceAprobar);

        // 5. INTENTO DE RESERVA EN TU BACKEND (RENDER)
        // Lo envolvemos en un try/catch aislado para que si Render falla o está lento, NO afecte al correo
        try {
            console.log("Intentando actualizar estado 'reserved' en Render...");
            await fetch(`${RENDER_BACKEND}/api/pay`, {
                method: 'POST',
                body: JSON.stringify({ 
                    orderId: miOrderIdTemporal, 
                    name: nombre, 
                    phone: telefono, 
                    nums: misNumerosSeleccionados 
                }),
                headers: { 'Content-Type': 'application/json' }
            });
            console.log("Sincronización con Render completada.");
        } catch (errBackend) {
            // Si Render falla, lo ignoramos visualmente para que el correo salga de todas formas
            console.warn("El backend de Render no respondió, pero procederemos con el envío del correo:", errBackend);
        }

        // 6. ENVÍO DIRECTO A FORMSPREE
        try {
            console.log("Enviando paquete de datos a Formspree...");
            const respuestaFormspree = await fetch(FORMSPREE_URL, {
                method: 'POST',
                body: datosParaCorreo,
                headers: { 'Accept': 'application/json' }
            });

            if (respuestaFormspree.ok) {
                console.log("¡Éxito total! Formspree recibió los datos.");
                alert("¡Solicitud enviada con éxito! Tu comprobante está en revisión.");
                window.location.reload(); // Reiniciamos todo limpiamente
            } else {
                const txtError = await respuestaFormspree.text();
                console.error("Formspree rechazó el envío:", txtError);
                alert("Formspree rechazó el formulario. Verifica que el formulario esté activo en su panel.");
            }
        } catch (errCorreo) {
            console.error("Error crítico de red al conectar con Formspree:", errCorreo);
            alert("No se pudo establecer conexión con el servidor de correos. Revisa tu conexión a internet.");
        }
    });
}
