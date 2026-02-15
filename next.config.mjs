/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const syncServerUrl = 'http://localhost:3001'; 
    
    return [
      {
        source: '/api/:path*',
        destination: `${syncServerUrl}/api/:path*`,
      },
      {
        source: '/videos/:path*',
        destination: `${syncServerUrl}/videos/:path*`,
      },
    ];
  },
};

export default nextConfig;