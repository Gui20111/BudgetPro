import Stripe from 'stripe';
import admin from 'firebase-admin';

// Inicializa Firebase Admin (só uma vez)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const planMap = {
    'price_1TT0UMR0wkFLWGjFs7XYe3Z4': 'pro',
    'price_1TT0WMR0wkFLWGjFiu0EKOAv': 'business',
  };

  try {
    switch (event.type) {

      // Pagamento confirmado — ativa o plano
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) break;

        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = subscription.items.data[0]?.price?.id;
        const plano = planMap[priceId] || 'pro';

        await db.collection('usuarios').doc(userId).set({
          plano,
          stripeCustomerId:    session.customer,
          stripeSubscriptionId: session.subscription,
          planoAtivadoEm:      admin.firestore.FieldValue.serverTimestamp(),
          planoExpiraEm:       new Date(subscription.current_period_end * 1000),
        }, { merge: true });

        console.log(`Plano ${plano} ativado para user ${userId}`);
        break;
      }

      // Renovação mensal — mantém ativo
      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const customerId = invoice.customer;

        const snap = await db.collection('usuarios')
          .where('stripeCustomerId', '==', customerId).limit(1).get();

        if (!snap.empty) {
          await snap.docs[0].ref.update({
            planoExpiraEm: new Date(subscription.current_period_end * 1000),
            planoAtivo: true,
          });
        }
        break;
      }

      // Cancelamento ou falha de pagamento — volta pro gratuito
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = event.data.object;
        const customerId = obj.customer;

        const snap = await db.collection('usuarios')
          .where('stripeCustomerId', '==', customerId).limit(1).get();

        if (!snap.empty) {
          await snap.docs[0].ref.update({
            plano: 'gratuito',
            planoAtivo: false,
          });
          console.log(`Plano cancelado para customer ${customerId}`);
        }
        break;
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
