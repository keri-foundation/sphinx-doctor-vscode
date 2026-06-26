"""Fixture for qualified-object resolution tests.

Contains both a module-level ``def state(...)`` and a ``class Kevery`` with
``def processReplyEndRole(...)`` to verify that the mapper resolves
``Kevery.processReplyEndRole`` to the class method, not the module-level
``state`` function.
"""


def state(pre, sn, pig, dig, fn, eilk, keys, eevt, stamp=None):
    """
    Returns instance of KeyStateRecord in support of key state notification messages.

    Parameters:
        pre (str): identifier prefix qb64
        sn (int): sequence number of latest event
        pig (str): SAID qb64 of prior event
        dig (str): SAID qb64 of latest (current) event
        fn (int):  first seen ordinal number of latest event
        eilk (str): event (message) type (ilk) of latest (current) event
        keys (list): qb64 signing keys
        eevt (StateEstEvent): namedtuple for latest est event

    """
    pass


class Kevery:
    """KERI event processor."""

    def processReplyEndRole(self, *, serder, diger, route, cigars=None, tsgs=None, **kwargs):
        """
        Process one reply message for route = /end/role/add or /end/role/cut
        with either attached nontrans receipt couples in cigars or attached trans
        indexed sig groups in tsgs.
        Assumes already validated diger, dater, and route from serder.ked

        Parameters:
            serder (SerderKERI): instance of reply msg (SAD)
            diger (Diger): instance from said in serder (SAD)
            route (str): reply route
            cigars (list): of Cigar instances
            tsgs (list): tuples (quadruples) of form
                (prefixer, seqner, diger, [sigers])

        Reply Message:
        {
          "v": "KERI10JSON00011c_",
          "t": "rpy",
          "d": "EZ-i0d8JZAoTNZH3ULaU6JR2nmwyvYAfSVPzhzS6b5CM",
          "dt": "2020-08-22T17:50:12.988921+00:00",
          "r": "/end/role/add",
          "a":
          {
             "cid": "EaU6JR2nmwyZ-i0d8JZAoTNZH3ULvYAfSVPzhzS6b5CM",
             "role": "watcher",
             "eid": "BrHLayDN-mXKv62DAjFLX1_Y5yEUe0vA9YPe_ihiKYHE",
          }
        }

        {
          "v": "KERI10JSON00011c_",
          "t": "rpy",
          "d": "EZ-i0d8JZAoTNZH3ULaU6JR2nmwyvYAfSVPzhzS6b5CM",
          "dt": "2020-08-22T17:50:12.988921+00:00",
          "r": "/end/role/cut",
          "a":
          {
             "cid": "EaU6JR2nmwyZ-i0d8JZAoTNZH3ULvYAfSVPzhzS6b5CM",
             "role": "watcher",
             "eid": "BrHLayDN-mXKv62DAjFLX1_Y5yEUe0vA9YPe_ihiKYHE",
          }
        }

        """
        pass
