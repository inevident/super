/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "a806-housingconnectapi.nyc.gov",
        pathname: "/MailTemplates/photos/**",
      },
      { protocol: "https", hostname: "www.nychdc.com", pathname: "/**" },
      { protocol: "https", hostname: "nychdc.com", pathname: "/**" },
      { protocol: "https", hostname: "residenewyork.com", pathname: "/**" },
      { protocol: "https", hostname: "www.residenewyork.com", pathname: "/**" },
      { protocol: "https", hostname: "fifthave.org", pathname: "/**" },
      { protocol: "https", hostname: "www.fifthave.org", pathname: "/**" },
      {
        protocol: "https",
        hostname: "cdn.shopify.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
