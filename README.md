# Recorridas

App para registrar las recorridas de cultivos por lote: texto, fotos, audio y video, con ubicación GPS. Funciona en iPhone, iPad y PC desde el navegador, y se puede instalar en la pantalla de inicio.

## Qué hace hoy (versión 1)

- Campañas (por ejemplo, "2026/27"), con sus lotes importados desde un KML o KMZ.
- Mapa satelital con los lotes. Tocás un lote y entrás a su línea de tiempo.
- Notas con texto, estado fenológico, plaga o enfermedad y nivel de daño.
- Fotos (comprimidas), video y audio grabado desde la app. Cada archivo guarda la ubicación del momento en que se cargó.
- "Nota rápida": usa el GPS para detectar en qué lote estás parado.
- Funciona sin señal. Los datos quedan guardados **solo en el dispositivo** por ahora.

## Próximas etapas

1. Usuarios y permisos por campo, con sincronización entre dispositivos (Supabase).
2. Transcripción y resumen automático de los audios (Gemini).

## Desarrollo

Es HTML, CSS y JavaScript sin compilación. Para probarla en la compu:

```sh
python3 -m http.server 8000
```

Después abrí http://localhost:8000. Se publica con GitHub Pages desde la rama `main`.

Cuando cambies archivos de la app, subí `VERSION` en `sw.js` para que los teléfonos tomen la versión nueva.

Librerías incluidas en `vendor/`: [Leaflet](https://leafletjs.com) 1.9.4 y [@tmcw/togeojson](https://github.com/placemark/togeojson) 5.8.1.
