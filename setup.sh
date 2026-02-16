#!/bin/bash
set -e

echo "=========================================="
echo " WhatsApp Control Center Pro - Setup"
echo "=========================================="

# Copy .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[OK] Created .env from .env.example"
else
  echo "[OK] .env already exists"
fi

echo ""
echo "Starting Docker services (PostgreSQL + Redis)..."
docker compose up -d db redis

echo ""
echo "Waiting for database to be ready..."
sleep 3

echo ""
echo "Installing backend dependencies..."
cd backend
npm install

echo ""
echo "Generating Prisma client..."
npx prisma generate

echo ""
echo "Running database migrations..."
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" npx prisma migrate deploy

echo ""
echo "Seeding database..."
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_cc" npm run db:seed

echo ""
echo "Installing frontend dependencies..."
cd ../frontend
npm install

echo ""
echo "=========================================="
echo " Setup Complete!"
echo "=========================================="
echo ""
echo "To start development servers:"
echo ""
echo "  Terminal 1 (Backend):"
echo "    cd backend && DATABASE_URL=\"postgresql://postgres:postgres@localhost:5432/whatsapp_cc\" REDIS_URL=\"redis://localhost:6379\" npm run dev"
echo ""
echo "  Terminal 2 (Frontend):"
echo "    cd frontend && npm run dev"
echo ""
echo "  Or use Docker Compose for everything:"
echo "    docker compose up"
echo ""
echo "Login credentials:"
echo "  Admin:  admin@demo.com / admin123"
echo "  Agent:  agent1@demo.com / agent123"
echo "  Agent:  agent2@demo.com / agent123"
echo "  Tenant: demo-company"
echo ""
echo "URLs:"
echo "  Frontend:  http://localhost:3000"
echo "  Backend:   http://localhost:4000"
echo "  API Docs:  http://localhost:4000/api/docs"
echo ""
