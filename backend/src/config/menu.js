import crypto from 'crypto';

export const defaultMenuItems = [
  { id: 1, name: 'Nshima and Chicken', category: 'meals', price: 25, image_url: 'https://picsum.photos/seed/nshimachk/400/300', description: 'Traditional nshima with fried chicken and vegetables', popular: 1 },
  { id: 2, name: 'Rice and Stew', category: 'meals', price: 20, image_url: 'https://picsum.photos/seed/ricestew/400/300', description: 'Fluffy rice with rich tomato stew and salad', popular: 1 },
  { id: 3, name: 'Sandwich Combo', category: 'meals', price: 18, image_url: 'https://picsum.photos/seed/sandwich1/400/300', description: 'Ham and cheese sandwich with a fruit side', popular: 0 },
  { id: 4, name: 'Chapati and Beans', category: 'meals', price: 15, image_url: 'https://picsum.photos/seed/chapatibns/400/300', description: 'Fresh chapati with baked beans', popular: 0 },
  { id: 5, name: 'Mac and Cheese', category: 'meals', price: 22, image_url: 'https://picsum.photos/seed/maccheese/400/300', description: 'Creamy macaroni and cheese with greens', popular: 1 },
  { id: 6, name: 'Fruit Juice', category: 'drinks', price: 8, image_url: 'https://picsum.photos/seed/fruitjuice/400/300', description: 'Freshly squeezed seasonal fruit juice', popular: 1 },
  { id: 7, name: 'Milkshake', category: 'drinks', price: 12, image_url: 'https://picsum.photos/seed/milkshk1/400/300', description: 'Creamy milkshake, chocolate or strawberry', popular: 0 },
  { id: 8, name: 'Bottled Water', category: 'drinks', price: 5, image_url: 'https://picsum.photos/seed/bottleh2o/400/300', description: 'Pure filtered water', popular: 0 },
  { id: 9, name: 'Hot Chocolate', category: 'drinks', price: 10, image_url: 'https://picsum.photos/seed/hotchoc1/400/300', description: 'Rich hot chocolate with marshmallow', popular: 1 },
  { id: 10, name: 'Banana', category: 'fruits', price: 5, image_url: 'https://picsum.photos/seed/bananafr/400/300', description: 'Fresh ripe banana', popular: 0 },
  { id: 11, name: 'Apple', category: 'fruits', price: 6, image_url: 'https://picsum.photos/seed/applefr1/400/300', description: 'Crisp red apple', popular: 0 },
  { id: 12, name: 'Fruit Salad', category: 'fruits', price: 15, image_url: 'https://picsum.photos/seed/fruslad1/400/300', description: 'Mixed seasonal fruit salad', popular: 1 },
  { id: 13, name: 'Popcorn', category: 'snacks', price: 8, image_url: 'https://picsum.photos/seed/popcorn1/400/300', description: 'Lightly salted freshly popped popcorn', popular: 0 },
  { id: 14, name: 'Samosa', category: 'snacks', price: 10, image_url: 'https://picsum.photos/seed/samosa01/400/300', description: 'Crispy samosa with savory filling', popular: 1 },
  { id: 15, name: 'Muffin', category: 'snacks', price: 8, image_url: 'https://picsum.photos/seed/muffin001/400/300', description: 'Blueberry or chocolate chip muffin', popular: 0 },
  { id: 16, name: 'Yogurt Cup', category: 'snacks', price: 10, image_url: 'https://picsum.photos/seed/yogurt01/400/300', description: 'Creamy yogurt with granola topping', popular: 0 },
  { id: 17, name: 'Ice Cream', category: 'treats', price: 12, image_url: 'https://picsum.photos/seed/icecream1/400/300', description: 'Vanilla, chocolate, or strawberry scoop', popular: 1 },
  { id: 18, name: 'Cake Slice', category: 'treats', price: 15, image_url: 'https://picsum.photos/seed/cakeslc1/400/300', description: 'Homemade chocolate cake slice', popular: 1 },
  { id: 19, name: 'Cookie Pack', category: 'treats', price: 8, image_url: 'https://picsum.photos/seed/cookie01/400/300', description: '3 freshly baked assorted cookies', popular: 0 },
  { id: 20, name: 'Fruit Punch', category: 'drinks', price: 10, image_url: 'https://picsum.photos/seed/frpunch1/400/300', description: 'Sweet tropical fruit punch', popular: 0 }
];

export function formatMenuItem(item, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const promoActive = Number(item.promo_percent) > 0 &&
    (!item.promo_start || item.promo_start <= today) &&
    (!item.promo_end || item.promo_end >= today);
  const basePrice = Number(item.price);
  const price = promoActive
    ? Math.round(basePrice * (100 - Number(item.promo_percent))) / 100
    : basePrice;

  return {
    id: item.id,
    name: item.name,
    category: item.category,
    price,
    base_price: basePrice,
    promo_percent: item.promo_percent == null ? null : Number(item.promo_percent),
    promo_start: item.promo_start,
    promo_end: item.promo_end,
    promo_active: promoActive,
    img: item.image_url,
    image_url: item.image_url,
    desc: item.description,
    description: item.description,
    popular: Boolean(item.popular),
    is_available: Boolean(item.is_available)
  };
}

export function validateMenuItem(payload) {
  const { name, category, description, price, image_url, popular, is_available, promo_percent, promo_start, promo_end } = payload || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw new Error('Food name is required and must be 100 characters or fewer.');
  }
  if (!['meals', 'drinks', 'snacks', 'fruits', 'treats'].includes(category)) {
    throw new Error('Choose a valid food category.');
  }
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 500) {
    throw new Error('Description is required and must be 500 characters or fewer.');
  }
  if (!Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) > 100000) {
    throw new Error('Price must be greater than zero and no more than 100,000.');
  }
  let parsedImageUrl;
  try {
    parsedImageUrl = new URL(image_url);
  } catch {
    throw new Error('Upload an image or provide a valid HTTPS image URL.');
  }
  if (typeof image_url !== 'string' || image_url.length > 2000 ||
    parsedImageUrl.protocol !== 'https:' || !parsedImageUrl.hostname) {
    throw new Error('Upload an image or provide a valid HTTPS image URL.');
  }
  if (typeof popular !== 'boolean' || typeof is_available !== 'boolean') {
    throw new Error('Select valid popularity and stock settings.');
  }

  let discount = promo_percent === '' || promo_percent == null ? null : Number(promo_percent);
  if (discount !== null && (!Number.isInteger(discount) || discount < 1 || discount > 99)) {
    throw new Error('Promotion discount must be a whole percentage from 1 to 99.');
  }
  const start = promo_start || null;
  const end = promo_end || null;
  const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if ((start && !validDate(start)) || (end && !validDate(end))) {
    throw new Error('Promotion dates must be valid calendar dates.');
  }
  if (start && end && start > end) {
    throw new Error('Promotion end date must be on or after its start date.');
  }
  if (discount === null && (start || end)) {
    throw new Error('Set a promotion percentage before adding promotion dates.');
  }

  return {
    name: name.trim(),
    category,
    description: description.trim(),
    price: Number(price),
    image_url: image_url.trim(),
    popular,
    is_available,
    promo_percent: discount,
    promo_start: start,
    promo_end: end
  };
}

export function createCloudinaryUploadSignature(apiSecret, timestamp) {
  return crypto.createHash('sha1')
    .update(`folder=ltscanteen/menu&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');
}
