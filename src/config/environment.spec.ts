import { validateEnvironment } from './environment';

const valid = {
  DATABASE_URL:
    'postgresql://neondb_owner:npg_LkszIHc58xDw@ep-bold-art-b38vjouh-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  JWT_SECRET: 'a-valid-secret-that-is-at-least-32-characters',
};

describe('Environment validation', () => {
  it('parses ports and supplies development defaults', () => {
    expect(validateEnvironment({ ...valid, PORT: '4000' })).toMatchObject({
      PORT: 4000,
      NODE_ENV: 'development',
      CORS_ORIGIN: 'http://localhost:3000',
    });
  });

  it.each(['', '0', '65536', 'invalid'])('rejects invalid port %s', (PORT) => {
    expect(() => validateEnvironment({ ...valid, PORT })).toThrow('PORT');
  });

  it('rejects missing and placeholder secrets', () => {
    expect(() =>
      validateEnvironment({ DATABASE_URL: valid.DATABASE_URL }),
    ).toThrow('JWT_SECRET');
    expect(() =>
      validateEnvironment({
        ...valid,
        JWT_SECRET: 'replace-with-a-random-secret-at-least-32-characters',
      }),
    ).toThrow('JWT_SECRET');
  });

  it('rejects non-PostgreSQL URLs without leaking credentials', () => {
    const DATABASE_URL = 'https://user:private-password@example.com';
    expect(() => validateEnvironment({ ...valid, DATABASE_URL })).toThrow(
      'DATABASE_URL',
    );
    expect(() => validateEnvironment({ ...valid, DATABASE_URL })).not.toThrow(
      'private-password',
    );
  });

  it('rejects CORS URLs that are not origins', () => {
    expect(() =>
      validateEnvironment({
        ...valid,
        CORS_ORIGIN: 'http://localhost:3000/path',
      }),
    ).toThrow('CORS_ORIGIN');
  });
});
