import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const DOWNLOAD_COUNT = 10;
const CONNECTION_TIMEOUT_MS = 10_000;
const MEGA = 1_000_000;

const HELP = `Использование: node speedtest.mjs <url>
Укажите прямой HTTP(S)-адрес файла. Утилита скачает его 10 раз подряд и выведет
среднее время запроса, суммарный объём и скорость скачивания.

  --help  Показать справку`;

/** @typedef {{ bytes: number, durationMs: number }} DownloadMeasurement */
/** @typedef {{ totalBytes: number, averageRequestDurationMs: number, bitsPerSecond: number }} SpeedtestResult */

/**
 * @typedef {object} SpeedtestOutput
 * @property {(percentage: number) => void} onProgress Получает процент завершённых запросов после каждого успешного скачивания.
 * @property {(result: SpeedtestResult) => void | Promise<void>} onComplete Получает итог успешной серии.
 */

/**
 * @param {DownloadMeasurement} measurement Объём в байтах и длительность в миллисекундах.
 * @returns {number} Скорость в битах в секунду.
 */
function calculateBitsPerSecond({ bytes, durationMs }) {
  return (bytes * 8) / (durationMs / 1000);
}

/**
 * @param {URL} url Прямой HTTP(S)-адрес файла.
 * @returns {Promise<DownloadMeasurement>} Объём полученного тела и длительность запроса.
 */
function downloadOnce(url) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = transport.get(url);

    request.once('socket', (socket) => {
      if (request.reusedSocket) return;

      const connectedEvent = isHttps ? 'secureConnect' : 'connect';
      const timer = setTimeout(() => {
        request.destroy(new Error(`Таймаут установки соединения (${CONNECTION_TIMEOUT_MS / 1000} с)`));
      }, CONNECTION_TIMEOUT_MS);

      function stopConnectionTimer() {
        clearTimeout(timer);
        socket.off(connectedEvent, stopConnectionTimer);
      }

      socket.once(connectedEvent, stopConnectionTimer);
      request.once('close', stopConnectionTimer);
    });

    request.once('error', reject);
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      reject(new Error(`HTTP ${response.statusCode}, ожидался HTTP 200`));
    });

    request.once('response', async (response) => {
      response.once('error', (error) => {
        reject(new Error(`Ответ оборван: ${error.message}`, { cause: error }));
      });

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}, ожидался HTTP 200`));
        request.destroy();
        return;
      }

      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.once('close', () => {
        if (!response.readableEnded) {
          reject(new Error('Ответ оборван до завершения чтения тела'));
        }
      });
      response.once('end', () => {
        if (!response.complete) {
          reject(new Error('Ответ оборван до завершения чтения тела'));
        } else if (bytes === 0) {
          reject(new Error('Пустое тело ответа'));
        } else {
          resolve({ bytes, durationMs: performance.now() - startedAt });
        }
      });
    });
  });
}

/**
 * @param {URL} url Адрес файла для всех попыток.
 * @param {SpeedtestOutput} output Обработчики прогресса и итогового результата.
 * @returns {Promise<void>} Завершается после вывода итогового результата.
 */
async function measureRepeatedDownloads(url, output) {
  let totalBytes = 0;
  let totalDurationMs = 0;

  for (let attempt = 1; attempt <= DOWNLOAD_COUNT; attempt += 1) {
    try {
      const { bytes, durationMs } = await downloadOnce(url);
      totalBytes += bytes;
      totalDurationMs += durationMs;
      output.onProgress((attempt / DOWNLOAD_COUNT) * 100);
    } catch (error) {
      throw new Error(`Попытка ${attempt}/${DOWNLOAD_COUNT}: ${error.message}`, { cause: error });
    }
  }

  await output.onComplete({
    totalBytes,
    averageRequestDurationMs: totalDurationMs / DOWNLOAD_COUNT,
    bitsPerSecond: calculateBitsPerSecond({ bytes: totalBytes, durationMs: totalDurationMs }),
  });
}

/** @param {SpeedtestResult} result Итог замера для вывода в консоль. */
function reportSuccess({ totalBytes, averageRequestDurationMs, bitsPerSecond }) {
  console.log([
    `Среднее время запроса: ${(averageRequestDurationMs / 1000).toFixed(2)} с`,
    `Суммарный объём: ${(totalBytes / MEGA).toFixed(6)} МБ`,
    `Скорость скачивания: ${(bitsPerSecond / MEGA).toFixed(2)} Мбит/с`,
  ].join('\n'));
}

/** @param {Error} error Ошибка, сообщение которой выводится в stderr. */
function reportError(error) {
  console.error(`Ошибка: ${error.message}`);
}

/** @param {number} percentage Доля завершённых запросов в процентах от 0 до 100. */
function reportProgress(percentage) {
  console.log(`Прогресс: ${percentage.toFixed(2)}%`);
}

/**
 * @param {string[]} argv Аргументы после имени скрипта.
 * @returns {Promise<number>} Код выхода CLI.
 */
async function main(argv) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { help: { type: 'boolean' } },
      allowPositionals: true,
    });

    if (values.help) {
      console.log(HELP);
      return 0;
    }

    if (positionals.length !== 1) {
      throw new Error('Укажите ровно один URL файла. Справка: node speedtest.mjs --help');
    }

    const [address] = positionals;
    const url = URL.parse(address);
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Некорректный URL. Укажите абсолютный адрес с протоколом HTTP или HTTPS');
    }

    await measureRepeatedDownloads(url, { onComplete: reportSuccess, onProgress: reportProgress });
    return 0;
  } catch (error) {
    reportError(error);
    return 1;
  }
}

const [,, ...args] = process.argv;

if (args.length === 1) {
  process.exitCode = await main(args);
} else {
  console.log(HELP);
}
