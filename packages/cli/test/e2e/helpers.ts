export async function waitForView(
  terminal: {
    serialize: () => {
      view: string;
    };
  },
  matcher: string | RegExp,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const view = terminal.serialize().view;
    const matched = typeof matcher === 'string' ? view.includes(matcher) : matcher.test(view);

    if (matched) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const finalView = terminal.serialize().view;
  throw new Error(`Timed out waiting for ${String(matcher)}. Final view:\n${finalView}`);
}

export async function waitForAbsence(
  terminal: {
    serialize: () => {
      view: string;
    };
  },
  matcher: string | RegExp,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const view = terminal.serialize().view;
    const matched = typeof matcher === 'string' ? view.includes(matcher) : matcher.test(view);

    if (!matched) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const finalView = terminal.serialize().view;
  throw new Error(
    `Timed out waiting for ${String(matcher)} to disappear. Final view:\n${finalView}`,
  );
}

export async function typeSlowly(
  terminal: {
    write: (value: string) => void;
  },
  text: string,
  delayMs = 30,
): Promise<void> {
  for (const char of text) {
    terminal.write(char);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
