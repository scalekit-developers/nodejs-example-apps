import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { Scalekit } from '@scalekit-sdk/node';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// JWT secret for token validation (in production, use a strong key from env)
const JWT_SECRET =
  process.env.JWT_SECRET || 'your-jwt-secret-key-change-in-production';

// Environment check
const isProduction = process.env.NODE_ENV === 'production';

// Refresh token storage - in production use Redis or a database
const refreshTokenStore = new Map();

const app = express();

const redirectUri = 'http://localhost:3000/api/callback';

const scalekit = new Scalekit(
  process.env.SCALEKIT_ENV_URL,
  process.env.SCALEKIT_CLIENT_ID,
  process.env.SCALEKIT_CLIENT_SECRET
);

console.log('ScaleKit initialized successfully');

// Mock user data (replace with database in production)
const users = [
  {
    id: 1,
    username: 'demo',
    password: '$2a$10$IpwiF1tRx0mXXxnprRZxoeZ6LY6zhRkaw6.1.An78ebUnauCskF/a',
    name: 'Demo User',
    email: process.env.DEMO_USER_EMAIL,
    role: 'User',
  },
];

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(
  session({
    secret: process.env.SESSION_SECRET ?? 'your-secret-key',
    resave: false,
    saveUninitialized: false,
  })
);

// Set cookie parser middleware
app.use(cookieParser());

// Setup CSRF protection
const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () =>
    process.env.CSRF_SECRET || 'csrf-secret-key-change-in-production',
  cookieName: '_csrf',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: '/',
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
});

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Add rate limiting for token endpoints - simplified version
const tokenRequestLimiter = (req, res, next) => {
  // In production, use a proper rate limiter like express-rate-limit
  next();
};

// Create middleware to verify JWT token
const verifyToken = (req, res, next) => {
  // Get token from Authorization header or cookie
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.split(' ')[1] : req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    // Properly verify token signature
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;
    next();
  } catch (error) {
    console.error('Token verification error:', error);

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }

    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Routes
app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/profile' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    res.redirect('/profile');
    return;
  }
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = users.find((user) => user.email === email);
    const isValidPassword =
      user && (await bcrypt.compare(password, user.password));

    if (isValidPassword) {
      req.session.user = { id: user.id, email: user.email };
      res.redirect('/profile');
      return;
    }

    res.render('login', { error: 'Invalid email or password' });
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'An error occurred during login' });
  }
});

app.get('/profile', isAuthenticated, (req, res) => {
  // First try to find user in our users array
  let user = users.find((user) => user.id === req.session.user.id);

  // If user not found in array but we have session data (SSO case)
  if (!user && req.session.user) {
    user = {
      id: req.session.user.id,
      name: req.session.user.name,
      email: req.session.user.email,
      username: req.session.user.username,
    };
  }

  // Get the decoded idToken if it exists
  let decodedToken = null;
  let userProfile = null;
  if (req.session.idToken) {
    try {
      decodedToken = jwt.decode(req.session.idToken);

      // Create a more comprehensive user profile object from token claims
      userProfile = {
        // Basic information
        id: decodedToken.sub,
        name:
          decodedToken.name ||
          `${decodedToken.given_name || ''} ${decodedToken.family_name || ''}`,
        email: decodedToken.email,
        username: decodedToken.preferred_username || decodedToken.email,

        // Additional information from claims if available
        givenName: decodedToken.given_name,
        familyName: decodedToken.family_name,
        middleName: decodedToken.middle_name,
        nickname: decodedToken.nickname,
        picture: decodedToken.picture,
        phoneNumber: decodedToken.phone_number,

        // Identity verification
        emailVerified: decodedToken.email_verified,
        phoneVerified: decodedToken.phone_number_verified,

        // Additional metadata
        locale: decodedToken.locale,
        zoneinfo: decodedToken.zoneinfo,

        // Groups and permissions if present
        groups: decodedToken.groups,
        roles: decodedToken.roles,
        permissions: decodedToken.permissions,

        // Token information
        issuer: decodedToken.iss,
        audience: decodedToken.aud,
        expiration: new Date(decodedToken.exp * 1000).toLocaleString(),
        issuedAt: new Date(decodedToken.iat * 1000).toLocaleString(),
        tokenType: decodedToken.token_type,
      };

      console.log('User profile from token:', userProfile);
    } catch (error) {
      console.error('Error decoding token:', error);
    }
  }

  res.render('profile', {
    user,
    idToken: decodedToken,
    userProfile,
  });
});

app.get('/logout', (req, res) => {
  // Get the refresh token to remove it from storage
  const refreshToken = req.cookies.refreshToken;
  if (refreshToken) {
    refreshTokenStore.delete(refreshToken);
  }

  // Clear session
  req.session.destroy(() => {
    // Clear auth cookies
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    res.clearCookie('_csrf');
    res.redirect('/login');
  });
});

app.get('/sso-login', (req, res) => {
  res.render('sso-login', { error: null });
});

app.post('/sso-login', (req, res) => {
  const { email } = req.body;
  let [, domain] = email.split('@');
  let options = Object.create({});
  // options['loginHint'] = email;
  // options['connectionId'] = 'conn_59615204090052747';
  options['scopes'] = ['openid', 'profile', 'email', 'offline_access'];

  try {
    const authorizationUrl = scalekit.getAuthorizationUrl(redirectUri, options);
    // const authorizationUrl = initiateAuth({
    //   env_url: process.env.SCALEKIT_ENV_URL,
    //   redirect_uri: redirectUri,
    //   scopes: options['scopes'],
    // });
    res.redirect(authorizationUrl);
    console.log('authorizationUrl', authorizationUrl, options);
  } catch (error) {
    console.error('SSO login error:', error);
    res.render('sso-login', {
      error: 'An error occurred while initiating SSO login',
    });
  }
});

app.get('/api/callback', async (req, res) => {
  const entireQuery = req.query;
  const { error, error_description, code } = entireQuery;

  if (error) {
    console.error('SSO callback error:', error, error_description);
    res.render('login', {
      error: `SSO login failed: ${error_description || error}`,
    });
    return;
  }

  try {
    console.log('requesting scalekit to exchange oauth code for token', code);
    const response = await exchangeCodeForToken({
      env_url: process.env.SCALEKIT_ENV_URL,
      code,
      redirect_uri: redirectUri,
      client_id: process.env.SCALEKIT_CLIENT_ID,
      client_secret: process.env.SCALEKIT_CLIENT_SECRET,
    });

    console.log('user claims', response);

    // Get user info from properly verified token
    let decodedToken;
    try {
      // Note: In a real system, you'd verify this with the auth provider's public key
      decodedToken = jwt.decode(response.id_token);
    } catch (error) {
      console.error('Token verification error:', error);
      res.render('login', {
        error: 'Invalid token received. Please try again.',
      });
      return;
    }

    // Store user info in session with more fields
    req.session.user = {
      id: decodedToken.sub,
      email: decodedToken.email,
      username: decodedToken.preferred_username || decodedToken.email,
      name:
        decodedToken.name ||
        `${decodedToken.given_name || ''} ${decodedToken.family_name || ''}`,
      givenName: decodedToken.given_name,
      familyName: decodedToken.family_name,
      picture: decodedToken.picture,
    };

    // Store idToken separately in session
    req.session.idToken = response.id_token;

    // Store refresh token in server-side storage
    const refreshTokenId = response.refresh_token;
    refreshTokenStore.set(refreshTokenId, {
      userId: decodedToken.sub,
      createdAt: new Date(),
    });

    // Set cookies with tokens for client-side access
    // Access token - accessible to JavaScript
    res.cookie('accessToken', response.access_token, {
      maxAge: (response.expires_in - 60) * 1000,
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      sameSite: 'strict',
    });

    // Refresh token - httpOnly to prevent JS access
    res.cookie('refreshToken', response.refresh_token, {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      sameSite: 'strict',
    });

    res.redirect('/profile');
  } catch (error) {
    console.error('Token exchange error:', error);
    res.render('login', {
      error: 'Failed to complete SSO login. Please try again.',
    });
  }
});

// Serve the CSRF token for client-side forms
app.get('/api/csrf-token', (req, res) => {
  const csrfToken = generateToken(res);
  res.json({ csrfToken });
});

// Add token refresh endpoint - server-side implementation with token rotation
app.post(
  '/api/refresh-token',
  doubleCsrfProtection,
  tokenRequestLimiter,
  async (req, res) => {
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' });
    }

    try {
      // Verify the refresh token structure (not using JWT_SECRET as refresh tokens are opaque)
      let tokenId;
      try {
        // If your refresh tokens are JWT format, you could decode them
        // For this example, we'll use the token itself as the ID
        tokenId = refreshToken;
      } catch (error) {
        return res
          .status(401)
          .json({ message: 'Invalid refresh token format' });
      }

      // Check if refresh token exists and is valid
      if (!refreshTokenStore.has(tokenId)) {
        return res
          .status(401)
          .json({ message: 'Refresh token invalid or expired' });
      }

      // Get stored refresh token data
      const storedData = refreshTokenStore.get(tokenId);

      // Delete the old refresh token (rotation)
      refreshTokenStore.delete(tokenId);

      // Get new tokens
      const refreshResponse = await refreshTokenExchange({
        env_url: process.env.SCALEKIT_ENV_URL,
        refresh_token: refreshToken,
        client_id: process.env.SCALEKIT_CLIENT_ID,
        client_secret: process.env.SCALEKIT_CLIENT_SECRET,
      });

      // Store the new refresh token
      const newRefreshTokenId = refreshResponse.refresh_token;
      refreshTokenStore.set(newRefreshTokenId, {
        userId: storedData.userId,
        createdAt: new Date(),
      });

      // Update the idToken in the session if a new one is provided
      if (refreshResponse.id_token) {
        req.session.idToken = refreshResponse.id_token;
      }

      // Set cookies with updated tokens
      // Access token - accessible to JavaScript
      res.cookie('accessToken', refreshResponse.access_token, {
        maxAge: (refreshResponse.expires_in - 60) * 1000,
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        sameSite: 'strict',
      });

      // Refresh token - httpOnly to prevent JS access
      res.cookie('refreshToken', refreshResponse.refresh_token, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        sameSite: 'strict',
      });

      // Return just the access token info (not the refresh token)
      return res.json({
        access_token: refreshResponse.access_token,
        expires_in: refreshResponse.expires_in,
      });
    } catch (error) {
      console.error('Error refreshing token:', error);
      return res.status(401).json({ message: 'Failed to refresh token' });
    }
  }
);

// Add protected API endpoints
app.get('/api/user-info', verifyToken, (req, res) => {
  // Return user info from the token
  return res.json({
    user: req.user,
    message: 'This is protected data',
  });
});

// Example of a protected POST endpoint that needs CSRF protection
app.post('/api/user-action', verifyToken, doubleCsrfProtection, (req, res) => {
  // This endpoint is protected both by JWT and CSRF token
  return res.json({
    success: true,
    message: 'Action performed successfully',
  });
});

async function exchangeCodeForToken({
  env_url,
  code,
  redirect_uri,
  client_id,
  client_secret,
}) {
  try {
    const response = await axios.post(
      `${env_url}/oauth/token`,
      null, // No request body needed
      {
        params: {
          code,
          redirect_uri,
          client_id,
          client_secret,
          grant_type: 'authorization_code',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error exchanging code for token:', error);
    throw error;
  }
}

async function initiateAuth({ env_url, redirect_uri, scopes }) {
  return `${env_url}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${redirect_uri}&scope=${scopes.join(
    ' '
  )}`;
}

async function refreshTokenExchange({
  env_url,
  refresh_token,
  client_id,
  client_secret,
}) {
  try {
    console.log(
      'trying to refresh the access token',
      JSON.stringify({
        env_url,
        refresh_token,
        client_id,
        client_secret,
      })
    );
    const response = await axios.post(`${env_url}/oauth/token`, null, {
      params: {
        refresh_token,
        client_id,
        client_secret,
        grant_type: 'refresh_token',
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error exchanging code for token:', error);
    throw error;
  }
}

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(
    `Server is running in ${
      process.env.NODE_ENV ?? 'development'
    } mode on port ${PORT}`
  );
});
