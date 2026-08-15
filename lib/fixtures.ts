// Offline fallback, captured verbatim from a live AGENT run against 33 W 89th.
// Carries the real footprint geometry, floor breakdown, tenant complaints, and
// the agent's own tool calls, so ?demo=1 is indistinguishable from the live path.
//
// Regenerate: POST /api/scan for the address, then feed the SSE frames back in.
// Before shipping a capture, check it: agent-sourced, no duplicate product urls,
// nothing hardwired, no kettle.

import type { AgentStep, BuildingProfile, Pick } from "./types";

export const DEMO_PROFILE: BuildingProfile = {
  "address": {
    "label": "33 WEST 89 STREET, New York, NY, USA",
    "bbl": "1012030020",
    "bin": "1031558",
    "borough": "Manhattan",
    "zip": "10024"
  },
  "totalViolations": 571,
  "openViolations": 513,
  "truncated": false,
  "signals": [
    {
      "kind": "lead paint",
      "count": 66,
      "window": "since 1996",
      "sample": "PAINT WITH LIGHT COLORED PAINT TO THE SATISFACTION OF THIS DEPARTMENT AT ALL WALLS AND CEILING AT PUBLIC HALL, 4th STORY"
    },
    {
      "kind": "hot water",
      "count": 59,
      "window": "since 2023",
      "sample": "PROVIDE HOT WATER AT ALL HOT WATER FIXTURES IN THE ENTIRE APARTMENT LOCATED AT APT 2C, 2nd STORY, 1st APARTMENT FROM WEST AT NORTH"
    },
    {
      "kind": "vermin",
      "count": 43,
      "window": "since 2022",
      "sample": "FILE ANNUAL BEDBUG REPORT IN ACCORDANCE WITH HPD RULE AS DESCRIBED ON THE BACK OF THIS NOTICE OF VIOLATION OR AS DESCRIBED ON HPD'S WEBSITE, WWW.NYC.GOV\\HPD, SE"
    },
    {
      "kind": "smoke alarm",
      "count": 39,
      "window": "since 2023",
      "sample": "REPAIR OR REPLACE THE CARBON MONOXIDE DETECTING DEVICE(S). DEFECTIVE IN THE ENTIRE APARTMENT LOCATED AT APT 2C, 2nd STORY, 1st APARTMENT FROM WEST AT NORTH"
    },
    {
      "kind": "heat",
      "count": 36,
      "window": "since 2023",
      "sample": "PROVIDE AN ADEQUATE SUPPLY OF HEAT FOR THE APARTMENT IN THE ENTIRE APARTMENT LOCATED AT APT 2C, 2nd STORY, 1st APARTMENT FROM WEST AT NORTH"
    }
  ],
  "neighborhood": [
    {
      "complaint": "Illegal Parking",
      "count": 2393
    },
    {
      "complaint": "HEAT/HOT WATER",
      "count": 2057
    },
    {
      "complaint": "Noise - Residential",
      "count": 1051
    },
    {
      "complaint": "Noise",
      "count": 753
    },
    {
      "complaint": "UNSANITARY CONDITION",
      "count": 555
    },
    {
      "complaint": "Street Condition",
      "count": 551
    }
  ],
  "facts": {
    "yearBuilt": 1895,
    "floors": 4,
    "residentialUnits": 9,
    "buildingArea": 6270,
    "sqftPerUnit": 697,
    "buildingClass": "C6",
    "walkUp": true,
    "preWar": true,
    "likelyLeadPaint": true
  },
  "footprint": {
    "ring": [
      [
        -73.968872872319,
        40.787971291462
      ],
      [
        -73.968999398851,
        40.787797672928
      ],
      [
        -73.969061206075,
        40.787823694207
      ],
      [
        -73.968956070343,
        40.787967960434
      ],
      [
        -73.968928873128,
        40.787956510438
      ],
      [
        -73.968907482431,
        40.787985862807
      ],
      [
        -73.968872872319,
        40.787971291462
      ]
    ],
    "heightRoof": 62.6925677,
    "groundElevation": 112
  },
  "floors": {
    "counts": {
      "1": 32,
      "2": 314,
      "3": 48,
      "4": 28
    },
    "parsed": 422,
    "worstFloor": 2,
    "worstUnit": {
      "apt": "2C",
      "count": 346
    }
  },
  "complaints": {
    "total": 896,
    "span": "2007\u20132026",
    "top": [
      {
        "category": "HEAT/HOT WATER",
        "count": 413
      },
      {
        "category": "GENERAL",
        "count": 82
      },
      {
        "category": "PLUMBING",
        "count": 76
      },
      {
        "category": "UNSANITARY CONDITION",
        "count": 76
      },
      {
        "category": "FLOORING/STAIRS",
        "count": 69
      },
      {
        "category": "PAINT/PLASTER",
        "count": 65
      }
    ]
  }
};

export const DEMO_STEPS: AgentStep[] = [
  {
    "type": "tool",
    "name": "search_products",
    "input": "true HEPA air purifier \u00b7 under $100"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "1 results \u00b7 PureZone\u2122 True HEPA Air Purifier $99.99"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "instant electric water heater faucet mount \u00b7 under $50"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "4 results \u00b7 Instant Tankless Electric Hot Wate $39.99 \u00b7 Instant Tankless Electric Hot Wate $47.99 \u00b7 Homelody Elektrischer Wasserhahn m $45.99"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "mouse traps \u00b7 under $20"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "2 results \u00b7 Rat, Mouse & Insect Glue Traps $15.72 \u00b7 Kness Pro-Ketch\u00ae Multiple Mousetra $17.99"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "smoke carbon monoxide alarm \u00b7 under $30"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "no results"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "carbon monoxide detector \u00b7 under $30"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "1 results \u00b7 XC0C-iR Smart Carbon Monoxide Alar $21.99"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "space heater \u00b7 under $30"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "no results"
  },
  {
    "type": "result",
    "name": "add_to_cart",
    "summary": "air purifier \u2014 PureZone\u2122 True HEPA Air Purifier $99.99"
  },
  {
    "type": "result",
    "name": "add_to_cart",
    "summary": "electric water heater \u2014 Instant Tankless Electric Hot Water Heat $39.99"
  },
  {
    "type": "result",
    "name": "add_to_cart",
    "summary": "traps \u2014 Rat, Mouse & Insect Glue Traps $15.72"
  },
  {
    "type": "result",
    "name": "add_to_cart",
    "summary": "CO detector \u2014 XC0C-iR Smart Carbon Monoxide Alarm $21.99"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "space heater small \u00b7 under $25"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "no results"
  },
  {
    "type": "tool",
    "name": "search_products",
    "input": "portable space heater \u00b7 under $25"
  },
  {
    "type": "result",
    "name": "search_products",
    "summary": "1 results \u00b7 Midea 2-In-1 Heater and Fan 4 Spee $21.99"
  },
  {
    "type": "result",
    "name": "add_to_cart",
    "summary": "space heater \u2014 Midea 2-In-1 Heater and Fan 4 Speed 1500 $21.99"
  }
];

export const DEMO_PICKS: Pick[] = [
  {
    "need": {
      "label": "air purifier",
      "query": "air purifier",
      "reason": "66 open lead paint violations; true HEPA captures lead dust",
      "urgency": "medium"
    },
    "product": {
      "title": "PureZone\u2122 True HEPA Air Purifier",
      "price": 99.99,
      "currency": "USD",
      "image": "https://cdn.shopify.com/s/files/1/0076/5172/1268/products/PEAIRPLG-M_1b_copy.jpg",
      "url": "https://pureenrichment.com/products/purezone-true-hepa-air-purifier?variant=39719928823902&_gsid=nnnKzsWwotJQ",
      "merchant": "pureenrichment.com"
    }
  },
  {
    "need": {
      "label": "electric water heater",
      "query": "electric water heater",
      "reason": "59 open hot water violations; faucet mount provides instant hot water",
      "urgency": "high"
    },
    "product": {
      "title": "Instant Tankless Electric Hot Water Heater Faucet",
      "price": 39.99,
      "currency": "GBP",
      "image": "https://cdn.shopify.com/s/files/1/0733/4622/0322/products/spp_20240116111605_2e19df3d76669894c2c72df84e2b6ce3.jpg",
      "url": "https://uxceller.com/products/kitchen-1?variant=47455047057698&_gsid=xb7G9nTeSAb1",
      "merchant": "uxceller.com"
    }
  },
  {
    "need": {
      "label": "traps",
      "query": "traps",
      "reason": "43 open vermin violations; glue traps monitor pest activity",
      "urgency": "high"
    },
    "product": {
      "title": "Rat, Mouse & Insect Glue Traps",
      "price": 15.72,
      "currency": "USD",
      "image": "https://cdn.shopify.com/s/files/1/0733/2577/3084/files/Shopify_Product_Images-402-AM-3_402_6-Pack.jpg",
      "url": "https://www.catchmaster.com/products/rat-mouse-snake-insect-sticky-glue-trays-indoors?variant=46675928318236&_gsid=TpEMrEDTwT3Q",
      "merchant": "catchmaster.com"
    }
  },
  {
    "need": {
      "label": "CO detector",
      "query": "CO detector",
      "reason": "39 open smoke/CO alarm violations; replacement device restores compliance",
      "urgency": "high"
    },
    "product": {
      "title": "XC0C-iR Smart Carbon Monoxide Alarm",
      "price": 21.99,
      "currency": "USD",
      "image": "https://cdn.shopify.com/s/files/1/0115/9223/7122/files/xc0c-ir-cover.webp",
      "url": "https://www.x-sense.com/products/x-sense-smart-carbon-monoxide-detector-xc0c-ir?variant=46732060918000&_gsid=ZpJUk7uZZK2L",
      "merchant": "x-sense.com"
    }
  },
  {
    "need": {
      "label": "space heater",
      "query": "space heater",
      "reason": "36 open heat violations; portable heater supplements inadequate building heat",
      "urgency": "high"
    },
    "product": {
      "title": "Midea 2-In-1 Heater and Fan 4 Speed 1500 Watts Digital Adjustable Tilt Portable",
      "price": 21.99,
      "currency": "USD",
      "image": "https://cdn.shopify.com/s/files/1/0578/9846/7390/files/57_9ccc942c-c911-4682-b475-47e07c882b6b.jpg",
      "url": "https://paylesshg.com/products/midea-2-in-1-heater-and-fan-4-speed-1500-watts-digital-adjustable-tilt-portable-1?variant=42758136528958&_gsid=16KktVtJd9yb",
      "merchant": "paylesshg.com"
    }
  }
];
