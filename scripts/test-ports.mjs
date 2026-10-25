import { createServer } from 'node:net';

async function probeLoopbackPort() {
  const server = createServer((socket) => socket.destroy());
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('TEST_PORT_PROBE_TIMEOUT')), 5000);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('INVALID_TEST_PORT_ADDRESS');
    return address.port;
  } finally {
    clearTimeout(timer);
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
  }
}

/** Avoids reusing this run's chosen numbers; closed probe sockets do not reserve them against other processes. */
export function createTestPortAllocator({ probe = probeLoopbackPort, maxAttempts = 100 } = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000)
    throw new TypeError('INVALID_TEST_PORT_ATTEMPT_LIMIT');
  const allocated = new Set();
  return async function allocate() {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = await probe();
      if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535)
        throw new Error('INVALID_TEST_PORT');
      if (allocated.has(candidate)) continue;
      // No await between checking and recording, including concurrent allocate calls.
      allocated.add(candidate);
      return candidate;
    }
    throw new Error('TEST_PORT_ALLOCATION_EXHAUSTED');
  };
}
