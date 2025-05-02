import express, { Request, Response } from "express";
import Hotel from "../models/hotel";
import { BookingType, HotelSearchResponse } from "../shared/types";
import { param, validationResult } from "express-validator";
import Stripe from "stripe";
import verifyToken from "../middleware/auth";

const stripe = new Stripe(process.env.STRIPE_API_KEY as string);

const router = express.Router();

// --- Search Hotels ---
router.get("/search", async (req: Request, res: Response) => {
  try {
    const query = constructSearchQuery(req.query);

    let sortOptions = {};
    switch (req.query.sortOption) {
      case "starRating":
        sortOptions = { starRating: -1 };
        break;
      case "pricePerNightAsc":
        sortOptions = { pricePerNight: 1 };
        break;
      case "pricePerNightDesc":
        sortOptions = { pricePerNight: -1 };
        break;
    }

    const pageSize = 5;
    const pageNumber = parseInt(req.query.page?.toString() || "1", 10);
    const skip = (pageNumber - 1) * pageSize;

    const hotels = await Hotel.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(pageSize);

    const total = await Hotel.countDocuments(query);

    const response: HotelSearchResponse = {
      data: hotels,
      pagination: {
        total,
        page: pageNumber,
        pages: Math.ceil(total / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error in hotel search:", error);
    res
      .status(500)
      .json({ message: "Something went wrong while searching hotels" });
  }
});

// --- Fetch All Hotels ---
router.get("/", async (_req: Request, res: Response) => {
  try {
    const hotels = await Hotel.find().sort({ lastUpdated: -1 });
    res.json(hotels);
  } catch (error) {
    console.error("Error fetching hotels:", error);
    res.status(500).json({ message: "Error fetching hotels" });
  }
});

// --- Fetch Single Hotel by ID ---
router.get(
  "/:id",
  [param("id").notEmpty().withMessage("Hotel ID is required")],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const id = req.params.id;

    try {
      const hotel = await Hotel.findById(id);
      if (!hotel) {
        return res.status(404).json({ message: "Hotel not found" });
      }
      res.json(hotel);
    } catch (error) {
      console.error("Error fetching hotel:", error);
      res.status(500).json({ message: "Error fetching hotel" });
    }
  }
);

// --- Create Stripe Payment Intent for Hotel Booking ---
router.post(
  "/:hotelId/bookings/payment-intent",
  verifyToken,
  async (req: Request, res: Response) => {
    const { numberOfNights } = req.body;
    const hotelId = req.params.hotelId;

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) {
      return res.status(400).json({ message: "Hotel not found" });
    }

    const totalCost = hotel.pricePerNight * numberOfNights;

    try {
      // 🛠️ 1. Create a Customer FIRST
      const customer = await stripe.customers.create({
        name: "Test User", // you can use req.user.name if you have
        address: {
          line1: "123 Test Street",
          city: "Hyderabad",
          state: "Telangana",
          country: "IN",
          postal_code: "500001",
        },
      });

      // 🛠️ 2. Now create PaymentIntent and link customer
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalCost * 100, // Stripe expects amount in cents
        currency: "inr",
        customer: customer.id, // 🛠️ IMPORTANT
        description: `Booking at ${hotel.name} for ${numberOfNights} nights`,
        metadata: {
          hotelId,
          userId: req.userId,
        },
      });

      res.json({
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        totalCost,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Error creating payment intent" });
    }
  }
);

// --- Confirm Booking after Payment ---
router.post(
  "/:hotelId/bookings",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const { paymentIntentId } = req.body;
      const hotelId = req.params.hotelId;

      const paymentIntent = await stripe.paymentIntents.retrieve(
        paymentIntentId
      );

      if (!paymentIntent) {
        return res.status(400).json({ message: "Payment intent not found" });
      }

      if (
        paymentIntent.metadata.hotelId !== hotelId ||
        paymentIntent.metadata.userId !== req.userId
      ) {
        return res
          .status(400)
          .json({ message: "Payment intent metadata mismatch" });
      }

      if (paymentIntent.status !== "succeeded") {
        return res.status(400).json({
          message: `Payment not succeeded. Status: ${paymentIntent.status}`,
        });
      }

      const newBooking: BookingType = {
        ...req.body,
        userId: req.userId,
      };

      const hotel = await Hotel.findOneAndUpdate(
        { _id: hotelId },
        {
          $push: { bookings: newBooking },
        },
        { new: true }
      );

      if (!hotel) {
        return res.status(404).json({ message: "Hotel not found" });
      }

      res.status(200).send({ message: "Booking successful" });
    } catch (error) {
      console.error("Error confirming booking:", error);
      res.status(500).json({ message: "Something went wrong" });
    }
  }
);

// --- Helper: Construct Dynamic Search Query ---
const constructSearchQuery = (queryParams: any) => {
  const constructedQuery: any = {};

  if (queryParams.destination) {
    constructedQuery.$or = [
      { city: new RegExp(queryParams.destination, "i") },
      { country: new RegExp(queryParams.destination, "i") },
    ];
  }

  if (queryParams.adultCount) {
    constructedQuery.adultCount = {
      $gte: parseInt(queryParams.adultCount, 10),
    };
  }

  if (queryParams.childCount) {
    constructedQuery.childCount = {
      $gte: parseInt(queryParams.childCount, 10),
    };
  }

  if (queryParams.facilities) {
    constructedQuery.facilities = {
      $all: Array.isArray(queryParams.facilities)
        ? queryParams.facilities
        : [queryParams.facilities],
    };
  }

  if (queryParams.types) {
    constructedQuery.type = {
      $in: Array.isArray(queryParams.types)
        ? queryParams.types
        : [queryParams.types],
    };
  }

  if (queryParams.stars) {
    const starRatings = Array.isArray(queryParams.stars)
      ? queryParams.stars.map((star: string) => parseInt(star, 10))
      : [parseInt(queryParams.stars, 10)];

    constructedQuery.starRating = { $in: starRatings };
  }

  if (queryParams.maxPrice) {
    constructedQuery.pricePerNight = {
      $lte: parseInt(queryParams.maxPrice, 10),
    };
  }

  return constructedQuery;
};

export default router;
