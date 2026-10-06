import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

/**
 * The same-origin guard is pure middleware, so these cases drive the real app over a
 * real socket: the status and code a forged browser POST has to produce, and the
 * client shapes that must keep working (no `Origin` at all, and safe methods).
 */

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

describe('same-origin guard', () => {
  it('rejects a mutation whose Origin names another host', async () => {
    const response = await request(base)
      .post('/api/files/init')
      .set('Origin', 'https://attacker.example')
      .send({ name: 'x', sizeBytes: '1' })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED')
  })

  it('rejects the opaque `Origin: null` a sandboxed frame sends', async () => {
    const response = await request(base)
      .post('/api/auth/login')
      .set('Origin', 'null')
      .send({ email: 'someone@example.com', password: 'Passw0rd123' })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED')
  })

  it('lets a same-origin mutation through to the route', async () => {
    const response = await request(base)
      .post('/api/files/init')
      .set('Origin', base)
      .send({ name: 'x', sizeBytes: '1' })

    // The guard passed; the route then rejected for want of a session.
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHORIZED')
  })

  it('lets a request with no Origin through, for non-browser clients', async () => {
    const response = await request(base).post('/api/files/init').send({ name: 'x', sizeBytes: '1' })

    expect(response.status).toBe(401)
  })

  it('never blocks a safe method, whatever the Origin', async () => {
    const response = await request(base).get('/api/health').set('Origin', 'https://attacker.example')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
  })
})
