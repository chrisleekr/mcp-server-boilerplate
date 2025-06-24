const globalSetup = async (): Promise<void> => {
  process.env.APP_ENV = 'spec';

  process.env.TZ = 'UTC';
};

export default globalSetup;
