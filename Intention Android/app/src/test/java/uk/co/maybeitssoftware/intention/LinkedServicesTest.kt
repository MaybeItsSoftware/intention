package uk.co.maybeitssoftware.intention

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkedServicesTest {
    @Test fun aSiteAndItsAppAreOneService() {
        assertTrue(LinkedServices.sameService("instagram.com", "com.instagram.android"))
        assertTrue(LinkedServices.sameService("com.instagram.android", "instagram.com"))
        assertTrue(LinkedServices.sameService("www.instagram.com", "com.instagram.android"))
    }

    @Test fun siblingsFromOneCompanyAreNot() {
        // Threads is published by Instagram's company but is its own service.
        assertFalse(LinkedServices.sameService("instagram.com", "com.instagram.barcelona"))
        assertFalse(LinkedServices.sameService("com.instagram.android", "com.instagram.barcelona"))
    }

    @Test fun unknownTargetsOnlyMatchThemselves() {
        assertTrue(LinkedServices.sameService("example.com", "example.com"))
        assertFalse(LinkedServices.sameService("example.com", "com.example.app"))
        assertFalse(LinkedServices.sameService(null, "instagram.com"))
        assertFalse(LinkedServices.sameService("", ""))
    }

    @Test fun appForSite() {
        assertEquals("com.instagram.android", LinkedServices.appForSite("instagram.com"))
        assertNull(LinkedServices.appForSite("example.com"))
    }
}
