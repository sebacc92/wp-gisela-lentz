import { component$ } from "@qwik.dev/core";
import {
  DocumentHeadTags,
  QwikRouterProvider,
  RouterOutlet,
} from "@qwik.dev/router";
import { BUSINESS_CONFIG } from "~/config/business";

import "./global.css";

const RouterDocument = component$(() => {
  /**
   * This is the root of a QwikRouter site. It contains the document's `<head>` and `<body>`. You can adjust them as you see fit.
   */

  return (
    <>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="application-name" content={BUSINESS_CONFIG.name} />
        <meta name="theme-color" content="#4b3442" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2" />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/brand/favicon-32.png?v=2"
        />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/brand/apple-touch-icon.png?v=2"
        />
        <link rel="manifest" href="/manifest.json" />

        <DocumentHeadTags />
      </head>
      <body>
        <RouterOutlet />
      </body>
    </>
  );
});

export default component$(() => (
  <QwikRouterProvider>
    <RouterDocument />
  </QwikRouterProvider>
));
